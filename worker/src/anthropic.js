// Claude API call and mock mode (SPEC.md 4.9).
// callModel(env, stage, message, fetchImpl) returns { kind, json, usage }:
//   kind  'ok' | 'refusal' | 'truncated' | 'invalid_json' | 'demo_closed'
//         | 'upstream_busy' | 'upstream_error' | 'internal_error'
//   json  the parsed model output when kind is 'ok', otherwise null
//   usage { input_tokens, output_tokens }; zero when the HTTP call failed
// MOCK_ANTHROPIC=1 returns fixtures and makes no call. Otherwise one non-streaming
// request goes to the Messages API. ANTHROPIC_API_KEY is read only in this file, and
// the key, the request and the response never go into an error or a log line.
import {
  MOCK_DELAY_MS,
  MOCK_SLOW_DELAY_MS,
  MOCK_USAGE,
  ANTHROPIC_URL,
  UPSTREAM_TIMEOUT_MS,
  MODEL_SETTINGS,
} from './config.js';
import { QUESTIONS_SCHEMA, PLAN_SCHEMA } from './schemas.js';
import { TRAIL_SYSTEM_PROMPT } from './prompts/trail.js';
import { QUESTIONS_FIXTURE } from './fixtures/questions.js';
import { PLAN_FIXTURE } from './fixtures/plan.js';
import { DECLINED_QUESTIONS_FIXTURE, DECLINED_PLAN_FIXTURE } from './fixtures/declined.js';

const ZERO_USAGE = { input_tokens: 0, output_tokens: 0 };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The mock reads the destination from the <trip_brief> JSON block of the user message.
function destinationFrom(message) {
  const match = /<trip_brief>\s*([\s\S]*?)\s*<\/trip_brief>/.exec(String(message));
  if (!match) return null;
  try {
    const brief = JSON.parse(match[1]);
    return typeof brief?.destination === 'string' ? brief.destination.trim() : null;
  } catch {
    return null;
  }
}

async function mockCall(stage, message) {
  const destination = destinationFrom(message);
  await sleep(destination === 'TEST-SLOW' ? MOCK_SLOW_DELAY_MS : MOCK_DELAY_MS);

  const usage = { ...(MOCK_USAGE[stage] || MOCK_USAGE.plan) };
  const isQuestions = stage === 'start';

  switch (destination) {
    case 'TEST-BUSY':
      return { kind: 'upstream_busy', json: null, usage: { ...ZERO_USAGE } };
    case 'TEST-REFUSAL':
      return { kind: 'refusal', json: null, usage };
    case 'TEST-TRUNCATED':
      return { kind: 'truncated', json: null, usage };
    case 'TEST-DECLINE':
      return {
        kind: 'ok',
        json: structuredClone(isQuestions ? DECLINED_QUESTIONS_FIXTURE : DECLINED_PLAN_FIXTURE),
        usage,
      };
    case 'TEST-BANNED':
      if (!isQuestions) {
        const json = structuredClone(PLAN_FIXTURE);
        json.honest_take = 'These are live prices for your dates.';
        return { kind: 'ok', json, usage };
      }
      break;
    default:
      break;
  }

  if (stage === 'revise') {
    // Task 11: mock revise returns the plan fixture with " (revised)" added to the title.
    const json = structuredClone(PLAN_FIXTURE);
    json.title = `${json.title} (revised)`;
    return { kind: 'ok', json, usage };
  }
  return { kind: 'ok', json: structuredClone(isQuestions ? QUESTIONS_FIXTURE : PLAN_FIXTURE), usage };
}

// ---- The real call -------------------------------------------------------------

const failed = (kind) => ({ kind, json: null, usage: { ...ZERO_USAGE } });

// Matches a 400 whose message is about the account's usage limits or credit balance.
const SPEND_LIMIT_MESSAGE = /usage limits?|credit balance/i;
const SPEND_LIMIT_CODE = 'enforced_spend_limit_reached';

// The request body from SPEC.md 4.9. No temperature, top_p, top_k or thinking:
// Haiku 5.5 rejects sampling settings and runs adaptive thinking when it is omitted.
export function buildRequestBody(env, stage, message) {
  const settings = MODEL_SETTINGS[stage];
  return {
    model: env.MODEL,
    max_tokens: settings.max_tokens,
    system: TRAIL_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: message }],
    output_config: {
      effort: settings.effort,
      format: { type: 'json_schema', schema: stage === 'start' ? QUESTIONS_SCHEMA : PLAN_SCHEMA },
    },
  };
}

function usageOf(data) {
  const u = data && typeof data.usage === 'object' && data.usage ? data.usage : {};
  const count = (n) => (Number.isInteger(n) && n >= 0 ? n : 0);
  return { input_tokens: count(u.input_tokens), output_tokens: count(u.output_tokens) };
}

// Joins the text of every content block whose type is text, ignoring thinking and
// any other block type. Blocks are chosen by type, never by position.
function textOf(data) {
  const blocks = Array.isArray(data?.content) ? data.content : [];
  return blocks
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
}

// Maps a non-200 response to its kind (4.9 rules 4 to 7).
function kindForStatus(status, error) {
  const message = typeof error?.message === 'string' ? error.message : '';
  const codes = [error?.type, error?.code];
  if (status === 400 && SPEND_LIMIT_MESSAGE.test(message)) return 'demo_closed';
  if (status === 429 && codes.includes(SPEND_LIMIT_CODE)) return 'demo_closed';
  if (status === 429 || status === 529) return 'upstream_busy';
  if (status >= 500) return 'upstream_error';
  return 'internal_error'; // 401, 403 and every other 4xx
}

const isAbort = (err) => err && (err.name === 'AbortError' || err.name === 'TimeoutError');

async function realCall(env, stage, message, fetchImpl) {
  const key = env.ANTHROPIC_API_KEY;
  if (typeof key !== 'string' || key.length === 0) return failed('internal_error');
  if (typeof env.MODEL !== 'string' || typeof env.ANTHROPIC_VERSION !== 'string') return failed('internal_error');

  let res;
  try {
    res = await fetchImpl(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': env.ANTHROPIC_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify(buildRequestBody(env, stage, message)),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch {
    return failed('upstream_error'); // a timeout or a network failure (rule 6)
  }

  if (res.status !== 200) {
    let error = null;
    try {
      error = (await res.json())?.error ?? null;
    } catch {
      error = null;
    }
    return failed(kindForStatus(res.status, error));
  }

  let data;
  try {
    data = await res.json();
  } catch (err) {
    return failed(isAbort(err) ? 'upstream_error' : 'invalid_json');
  }

  const usage = usageOf(data); // rule 8: a completed call is charged even if its output is bad
  switch (data?.stop_reason) {
    case 'end_turn':
      try {
        return { kind: 'ok', json: JSON.parse(textOf(data)), usage };
      } catch {
        return { kind: 'invalid_json', json: null, usage };
      }
    case 'refusal':
      return { kind: 'refusal', json: null, usage };
    case 'max_tokens':
      return { kind: 'truncated', json: null, usage };
    default:
      // Any other stop reason cannot carry a finished JSON answer.
      return { kind: 'invalid_json', json: null, usage };
  }
}

// fetchImpl lets tests inject a fake. The default calls the global fetch unbound,
// which Workers require.
const defaultFetch = (...args) => fetch(...args);

export async function callModel(env, stage, message, fetchImpl = defaultFetch) {
  if (!Object.hasOwn(MODEL_SETTINGS, stage)) return failed('internal_error');
  if (env.MOCK_ANTHROPIC === '1') return mockCall(stage, message);
  return realCall(env, stage, message, fetchImpl);
}
