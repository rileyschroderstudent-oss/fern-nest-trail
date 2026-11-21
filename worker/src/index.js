// Router, CORS and the error envelope (SPEC.md 4.3 and 4.4).
import {
  VERSION,
  BODY_LIMIT_BYTES,
  BRIEF_LIMITS,
  VISITOR_TRIPS_PER_DAY,
  PRICES,
  MAX_REVISIONS,
  CONTINGENCY_PCT,
  CONTINGENCY_FAR_PCT,
  CONTINGENCY_FAR_MONTHS,
} from './config.js';
import { callModel } from './anthropic.js';
import { buildMessage } from './messages.js';
import { shapeQuestions, shapePlan } from './postvalidate.js';
import { validateStartBody, validatePlanBody, validateAnswers } from './validate.js';
import { issueSession, verifySession, hasUsableSecret } from './session.js';

// Known routes and the methods each accepts. A known path with another method
// gets 405; an unknown path gets 404.
const ROUTES = {
  '/api/status': 'GET',
  '/api/trail/start': 'POST',
  '/api/trail/plan': 'POST',
  '/api/trail/revise': 'POST',
};

const ERROR_MESSAGES = {
  not_found: 'Not found.',
  method_not_allowed: 'Method not allowed.',
  invalid_input: 'Invalid input.',
  forbidden_origin: 'Origin not allowed.',
  invalid_session: 'This trip cannot be continued.',
  session_expired: 'This trip has expired.',
  demo_closed: 'The demo is closed.',
  upstream_busy: 'Claude is busy. Try again in a minute.',
  upstream_error: 'Claude could not be reached.',
  bad_model_output: 'The model returned malformed output.',
  internal_error: 'Something went wrong.',
};


function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== '*');
}

function isAllowedOrigin(env, origin) {
  return typeof origin === 'string' && allowedOrigins(env).includes(origin);
}

function corsHeaders(env, request) {
  const headers = { Vary: 'Origin' };
  const origin = request.headers.get('Origin');
  if (isAllowedOrigin(env, origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

function json(env, request, status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...corsHeaders(env, request),
      ...extraHeaders,
    },
  });
}

export function errorResponse(env, request, status, code, extra = {}) {
  const error = {
    code,
    message: ERROR_MESSAGES[code] || ERROR_MESSAGES.internal_error,
    retryAfterSeconds: extra.retryAfterSeconds ?? null,
    reopensAt: extra.reopensAt ?? null,
    fields: extra.fields ?? [],
  };
  const headers = {};
  if (error.retryAfterSeconds != null) headers['Retry-After'] = String(error.retryAfterSeconds);
  return json(env, request, status, { error }, headers);
}

function preflight(env, request) {
  return new Response(null, {
    status: 204,
    headers: {
      'Cache-Control': 'no-store',
      ...corsHeaders(env, request),
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

function status(env, request) {
  return json(env, request, 200, {
    ok: true,
    open: true,
    reason: null,
    reopensAt: null,
    mock: env.MOCK_ANTHROPIC === '1',
    model: env.MODEL,
    version: VERSION,
    limits: {
      tripsPerVisitorPerDay: VISITOR_TRIPS_PER_DAY,
      maxNights: BRIEF_LIMITS.nights.max,
      maxTravellers: BRIEF_LIMITS.travellers.max,
    },
  });
}

// 15 when month is set and the travel month is 12 or more months after the current
// UTC month; otherwise 10 (SPEC.md 4.7).
export function contingencyPct(brief, now) {
  if (brief.month === 0) return CONTINGENCY_PCT;
  const travel = brief.year * 12 + (brief.month - 1);
  const current = now.getUTCFullYear() * 12 + now.getUTCMonth();
  return travel - current >= CONTINGENCY_FAR_MONTHS ? CONTINGENCY_FAR_PCT : CONTINGENCY_PCT;
}

const isoSeconds = (now) => now.toISOString().replace(/\.\d{3}Z$/, 'Z');


const bodyError = (problem) => ({ ok: false, fields: [{ name: 'body', problem }] });

// Reads a JSON body (SPEC.md 4.3 step 6 and Task 5): checks its size in bytes against
// the route's limit, requires Content-Type: application/json, decodes it as UTF-8 and
// parses it. Returns { ok: true, body } or { ok: false, fields }.
async function readJsonBody(request, limitBytes) {
  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > limitBytes) return bodyError('too_large');

  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > limitBytes) return bodyError('too_large');

  const mediaType = (request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (mediaType !== 'application/json') return bodyError('content_type');

  let body;
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return bodyError('invalid_json');
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return bodyError('not_an_object');
  return { ok: true, body };
}

const invalidInput = (env, request, fields) => errorResponse(env, request, 400, 'invalid_input', { fields });

// Maps a failed or refused model call to its response. Returns null when kind is 'ok'.
function modelFailure(env, request, kind) {
  switch (kind) {
    case 'ok':
      return null;
    case 'refusal':
      return json(env, request, 200, { type: 'declined', reason: 'other' });
    case 'truncated':
    case 'invalid_json':
      return errorResponse(env, request, 502, 'bad_model_output');
    case 'demo_closed':
      return errorResponse(env, request, 503, 'demo_closed');
    case 'upstream_busy':
      return errorResponse(env, request, 502, 'upstream_busy');
    case 'upstream_error':
      return errorResponse(env, request, 502, 'upstream_error');
    default:
      return errorResponse(env, request, 500, 'internal_error');
  }
}

async function trailStart(request, env) {
  const read = await readJsonBody(request, BODY_LIMIT_BYTES.start);
  if (!read.ok) return invalidInput(env, request, read.fields);

  const now = new Date();
  const valid = validateStartBody(read.body, now);
  if (!valid.ok) return invalidInput(env, request, valid.fields);
  const { brief } = valid.value;

  const result = await callModel(env, 'start', buildMessage('start', { brief }, now));
  const failure = modelFailure(env, request, result.kind);
  if (failure) return failure;

  const shaped = shapeQuestions(result.json);
  if (!shaped.ok) return errorResponse(env, request, 502, 'bad_model_output');
  if (shaped.value.type === 'declined') return json(env, request, 200, shaped.value);

  return json(env, request, 200, {
    type: 'questions',
    assumptions: shaped.value.assumptions,
    questions: shaped.value.questions,
    session: await issueSession(env, { stage: 'questions', brief, questions: shaped.value.questions }, now),
  });
}

async function trailPlan(request, env) {
  const read = await readJsonBody(request, BODY_LIMIT_BYTES.plan);
  if (!read.ok) return invalidInput(env, request, read.fields);
  const valid = validatePlanBody(read.body);
  if (!valid.ok) return invalidInput(env, request, valid.fields);

  const now = new Date();
  const session = await verifySession(env, valid.value.session, { stage: 'questions', now });
  if (!session.ok) {
    return errorResponse(env, request, session.code === 'session_expired' ? 410 : 401, session.code);
  }
  const { brief, questions } = session.payload;

  const answers = validateAnswers(valid.value.answers, questions);
  if (!answers.ok) return invalidInput(env, request, answers.fields);

  const result = await callModel(env, 'plan', buildMessage('plan', { brief, questions, answers: answers.value }, now));
  const failure = modelFailure(env, request, result.kind);
  if (failure) return failure;

  const shaped = shapePlan(result.json, brief);
  if (!shaped.ok) return errorResponse(env, request, 502, 'bad_model_output');
  if (shaped.value.type === 'declined') return json(env, request, 200, shaped.value);

  return json(env, request, 200, {
    type: 'plan',
    plan: shaped.value,
    warnings: shaped.warnings,
    contingencyPct: contingencyPct(brief, now),
    travellers: brief.travellers,
    budgetPerPersonAud: brief.budgetPerPersonAud,
    generatedAt: isoSeconds(now),
    session: await issueSession(env, { stage: 'plan', revs: 0, brief, questions, answers: answers.value }, now),
    revisionsLeft: MAX_REVISIONS,
  });
}

async function route(request, env) {
  const { pathname } = new URL(request.url);
  const method = request.method;

  if (method === 'OPTIONS') return preflight(env, request);

  if (method === 'POST' && !isAllowedOrigin(env, request.headers.get('Origin'))) {
    return errorResponse(env, request, 403, 'forbidden_origin');
  }

  const allowed = ROUTES[pathname];
  if (!allowed) return errorResponse(env, request, 404, 'not_found');
  if (method !== allowed) return errorResponse(env, request, 405, 'method_not_allowed');

  if (pathname === '/api/status') return status(env, request);

  // An unpriced model can never run uncapped (SPEC.md 4.8).
  if (!Object.hasOwn(PRICES, env.MODEL)) return errorResponse(env, request, 500, 'internal_error');
  // Tokens cannot be signed or checked without a long enough secret (SPEC.md Task 6).
  if (!hasUsableSecret(env)) return errorResponse(env, request, 500, 'internal_error');

  if (pathname === '/api/trail/start') return trailStart(request, env);
  if (pathname === '/api/trail/plan') return trailPlan(request, env);

  // /api/trail/revise arrives in Task 11.
  return errorResponse(env, request, 404, 'not_found');
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env, ctx);
    } catch {
      // Never log the request, its body or the error detail.
      return errorResponse(env, request, 500, 'internal_error');
    }
  },
};
