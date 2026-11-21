// Router, CORS and the error envelope (SPEC.md 4.3 and 4.4).
import { VERSION, BRIEF_LIMITS, VISITOR_TRIPS_PER_DAY } from './config.js';

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
  forbidden_origin: 'Origin not allowed.',
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

  // The trail routes are added in later tasks.
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
