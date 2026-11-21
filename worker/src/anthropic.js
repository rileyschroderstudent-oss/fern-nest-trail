// Claude API call and mock mode (SPEC.md 4.9).
// callModel(env, stage, message) returns { kind, json, usage }:
//   kind  'ok' | 'refusal' | 'truncated' | 'invalid_json' | 'demo_closed'
//         | 'upstream_busy' | 'upstream_error' | 'internal_error'
//   json  the parsed model output when kind is 'ok', otherwise null
//   usage { input_tokens, output_tokens }; zero when the HTTP call failed
// Only mock mode exists so far. The real API path is added in Task 7.
import { MOCK_DELAY_MS, MOCK_SLOW_DELAY_MS, MOCK_USAGE } from './config.js';
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

  return { kind: 'ok', json: structuredClone(isQuestions ? QUESTIONS_FIXTURE : PLAN_FIXTURE), usage };
}

export async function callModel(env, stage, message) {
  if (env.MOCK_ANTHROPIC === '1') return mockCall(stage, message);
  // The real API path arrives in Task 7. Until then, never call out.
  return { kind: 'internal_error', json: null, usage: { ...ZERO_USAGE } };
}
