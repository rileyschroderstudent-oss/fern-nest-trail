// Real Claude API path tests (SPEC.md 4.9 and Task 7). Every test injects a fake
// fetch; no test reaches the network.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { callModel, buildRequestBody } from '../src/anthropic.js';
import { TRAIL_SYSTEM_PROMPT } from '../src/prompts/trail.js';
import { QUESTIONS_SCHEMA, PLAN_SCHEMA } from '../src/schemas.js';

const ENV = {
  MOCK_ANTHROPIC: '0',
  ANTHROPIC_API_KEY: 'sk-ant-test-not-a-real-key',
  MODEL: 'claude-haiku-5-5',
  ANTHROPIC_VERSION: '2023-06-01',
};
const MESSAGE = 'Today is 2026-11-16 (UTC).\nSTAGE: plan\n<trip_brief>\n{}\n</trip_brief>\nWrite the trip plan.';
const USAGE = { input_tokens: 4150, output_tokens: 4500 };
const ZERO = { input_tokens: 0, output_tokens: 0 };
const OUTPUT = { status: 'ok', decline_reason: 'none' };

const jsonResponse = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});
const message = (stopReason, content, usage = USAGE) => ({
  id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-haiku-5-5',
  content, stop_reason: stopReason, usage,
});
const text = (t) => ({ type: 'text', text: t });
const apiError = (type, msg) => ({ type: 'error', error: { type, message: msg } });

// A fake fetch that records the call and returns a fixed response (or throws).
function fakeFetch(respond) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return respond(url, init);
  };
  impl.calls = calls;
  return impl;
}

// One row per 4.9 handling rule.
const RULES = [
  {
    rule: '1: HTTP 200 and end_turn parses the joined text blocks',
    respond: () => jsonResponse(200, message('end_turn', [text('{"status":'), text('"ok","decline_reason":"none"}')])),
    expect: { kind: 'ok', json: OUTPUT, usage: USAGE },
  },
  {
    rule: '2: stop_reason refusal is a refusal',
    respond: () => jsonResponse(200, message('refusal', [])),
    expect: { kind: 'refusal', json: null, usage: USAGE },
  },
  {
    rule: '3a: stop_reason max_tokens is truncated',
    respond: () => jsonResponse(200, message('max_tokens', [text('{"status":"ok","ti')])),
    expect: { kind: 'truncated', json: null, usage: USAGE },
  },
  {
    rule: '3b: end_turn with text that is not JSON is invalid_json',
    respond: () => jsonResponse(200, message('end_turn', [text('Here is your plan!')])),
    expect: { kind: 'invalid_json', json: null, usage: USAGE },
  },
  {
    rule: '4a: HTTP 400 about usage limits is demo_closed',
    respond: () => jsonResponse(400, apiError('invalid_request_error', 'You have reached your specified API usage limits.')),
    expect: { kind: 'demo_closed', json: null, usage: ZERO },
  },
  {
    rule: '4b: HTTP 400 about the credit balance is demo_closed',
    respond: () => jsonResponse(400, apiError('invalid_request_error', 'Your credit balance is too low to access the API.')),
    expect: { kind: 'demo_closed', json: null, usage: ZERO },
  },
  {
    rule: '4c: HTTP 429 with error code enforced_spend_limit_reached is demo_closed',
    respond: () => jsonResponse(429, apiError('enforced_spend_limit_reached', 'Spend limit reached.')),
    expect: { kind: 'demo_closed', json: null, usage: ZERO },
  },
  {
    rule: '5a: any other HTTP 429 is upstream_busy',
    respond: () => jsonResponse(429, apiError('rate_limit_error', 'Number of requests has exceeded your rate limit.')),
    expect: { kind: 'upstream_busy', json: null, usage: ZERO },
  },
  {
    rule: '5b: HTTP 529 is upstream_busy',
    respond: () => jsonResponse(529, apiError('overloaded_error', 'Overloaded')),
    expect: { kind: 'upstream_busy', json: null, usage: ZERO },
  },
  {
    rule: '6a: HTTP 5xx is upstream_error',
    respond: () => jsonResponse(500, apiError('api_error', 'Internal server error')),
    expect: { kind: 'upstream_error', json: null, usage: ZERO },
  },
  {
    rule: '6b: a timeout is upstream_error',
    respond: () => { throw new DOMException('The operation timed out.', 'TimeoutError'); },
    expect: { kind: 'upstream_error', json: null, usage: ZERO },
  },
  {
    rule: '6c: a network failure is upstream_error',
    respond: () => { throw new TypeError('fetch failed'); },
    expect: { kind: 'upstream_error', json: null, usage: ZERO },
  },
  {
    rule: '7a: HTTP 401 is internal_error',
    respond: () => jsonResponse(401, apiError('authentication_error', 'invalid x-api-key')),
    expect: { kind: 'internal_error', json: null, usage: ZERO },
  },
  {
    rule: '7b: HTTP 403 is internal_error',
    respond: () => jsonResponse(403, apiError('permission_error', 'Not allowed')),
    expect: { kind: 'internal_error', json: null, usage: ZERO },
  },
  {
    rule: '7c: any other 4xx, such as a plain 400 or 404, is internal_error',
    respond: () => jsonResponse(400, apiError('invalid_request_error', 'output_config.format: invalid schema')),
    expect: { kind: 'internal_error', json: null, usage: ZERO },
  },
  {
    rule: '8: usage is read from the response, and is zero for a failed HTTP call',
    respond: () => jsonResponse(200, message('end_turn', [text('{"status":"ok","decline_reason":"none"}')], { input_tokens: 7, output_tokens: 11 })),
    expect: { kind: 'ok', json: OUTPUT, usage: { input_tokens: 7, output_tokens: 11 } },
  },
];

describe('callModel: the eight 4.9 handling rules', () => {
  for (const { rule, respond, expect } of RULES) {
    test(`rule ${rule}`, async () => {
      const fetchImpl = fakeFetch(respond);
      assert.deepEqual(await callModel(ENV, 'plan', MESSAGE, fetchImpl), expect);
      assert.equal(fetchImpl.calls.length, 1);
    });
  }

  test('a 200 whose body is not JSON is invalid_json with zero usage', async () => {
    const fetchImpl = fakeFetch(() => new Response('<html>oops</html>', { status: 200 }));
    assert.deepEqual(await callModel(ENV, 'plan', MESSAGE, fetchImpl), { kind: 'invalid_json', json: null, usage: ZERO });
  });

  test('an error response with no JSON body still maps by status', async () => {
    const fetchImpl = fakeFetch(() => new Response('Bad gateway', { status: 502 }));
    assert.equal((await callModel(ENV, 'plan', MESSAGE, fetchImpl)).kind, 'upstream_error');
  });

  test('an unexpected stop reason cannot be used as a plan', async () => {
    const fetchImpl = fakeFetch(() => jsonResponse(200, message('pause_turn', [text('{}')])));
    assert.equal((await callModel(ENV, 'plan', MESSAGE, fetchImpl)).kind, 'invalid_json');
  });
});

describe('callModel: response parsing', () => {
  test('a response whose first block is thinking still parses', async () => {
    const content = [
      { type: 'thinking', thinking: '', signature: 'sig' },
      text('{"status":"ok","decline_reason":"none"}'),
    ];
    const fetchImpl = fakeFetch(() => jsonResponse(200, message('end_turn', content)));
    assert.deepEqual(await callModel(ENV, 'plan', MESSAGE, fetchImpl), { kind: 'ok', json: OUTPUT, usage: USAGE });
  });

  test('blocks are chosen by type, never by position', async () => {
    const content = [
      { type: 'thinking', thinking: 'not JSON', signature: 's' },
      text('{"status":"ok",'),
      { type: 'redacted_thinking', data: 'xyz' },
      text('"decline_reason":"none"}'),
    ];
    const fetchImpl = fakeFetch(() => jsonResponse(200, message('end_turn', content)));
    assert.deepEqual((await callModel(ENV, 'plan', MESSAGE, fetchImpl)).json, OUTPUT);
  });
});

describe('callModel: the request', () => {
  const sent = async (stage = 'plan', env = ENV) => {
    const fetchImpl = fakeFetch(() => jsonResponse(200, message('end_turn', [text('{}')])));
    await callModel(env, stage, MESSAGE, fetchImpl);
    const [{ url, init }] = fetchImpl.calls;
    return { url, init, body: JSON.parse(init.body) };
  };

  test('goes to the Messages API with the three headers and an abort signal', async () => {
    const { url, init } = await sent();
    assert.equal(url, 'https://api.anthropic.com/v1/messages');
    assert.equal(init.method, 'POST');
    assert.deepEqual(init.headers, {
      'x-api-key': ENV.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    });
    assert.ok(init.signal instanceof AbortSignal);
  });

  test('has no temperature, top_p, top_k or thinking key', async () => {
    for (const stage of ['start', 'plan', 'revise']) {
      const { body } = await sent(stage);
      for (const key of ['temperature', 'top_p', 'top_k', 'thinking']) {
        assert.equal(Object.hasOwn(body, key), false, `${stage} sends ${key}`);
      }
    }
  });

  test('has output_config.format.type json_schema with the stage schema', async () => {
    assert.equal((await sent('start')).body.output_config.format.type, 'json_schema');
    assert.deepEqual((await sent('start')).body.output_config.format.schema, QUESTIONS_SCHEMA);
    assert.deepEqual((await sent('plan')).body.output_config.format.schema, PLAN_SCHEMA);
    assert.deepEqual((await sent('revise')).body.output_config.format.schema, PLAN_SCHEMA);
  });

  test('takes model from env.MODEL', async () => {
    assert.equal((await sent('plan', { ...ENV, MODEL: 'claude-sonnet-5-5' })).body.model, 'claude-sonnet-5-5');
  });

  test('ends messages with a user turn holding the message, and sends the system prompt', async () => {
    const { body } = await sent();
    assert.deepEqual(body.messages.at(-1), { role: 'user', content: MESSAGE });
    assert.equal(body.messages.length, 1);
    assert.equal(body.system, TRAIL_SYSTEM_PROMPT);
  });

  test('uses the 4.2 settings per stage: max_tokens and effort', async () => {
    assert.deepEqual(
      [(await sent('start')).body, (await sent('plan')).body].map((b) => [b.max_tokens, b.output_config.effort]),
      [[2000, 'low'], [8000, 'medium']],
    );
  });

  test('matches the 4.9 body exactly, with no other keys', () => {
    const body = buildRequestBody(ENV, 'plan', MESSAGE);
    assert.deepEqual(Object.keys(body).sort(), ['max_tokens', 'messages', 'model', 'output_config', 'system']);
    assert.deepEqual(Object.keys(body.output_config).sort(), ['effort', 'format']);
  });

  test('without an API key nothing is sent', async () => {
    const fetchImpl = fakeFetch(() => assert.fail('no call should be made'));
    const r = await callModel({ ...ENV, ANTHROPIC_API_KEY: '' }, 'plan', MESSAGE, fetchImpl);
    assert.equal(r.kind, 'internal_error');
    assert.equal(fetchImpl.calls.length, 0);
  });

  test('mock mode never calls fetch', async () => {
    const fetchImpl = fakeFetch(() => assert.fail('no call should be made'));
    const r = await callModel({ ...ENV, MOCK_ANTHROPIC: '1' }, 'start', MESSAGE, fetchImpl);
    assert.equal(r.kind, 'ok');
    assert.equal(fetchImpl.calls.length, 0);
  });

  test('the key, request and response never appear in a result', async () => {
    for (const { respond } of RULES) {
      const r = await callModel(ENV, 'plan', MESSAGE, fakeFetch(respond));
      const out = JSON.stringify(r);
      assert.ok(!out.includes(ENV.ANTHROPIC_API_KEY));
      assert.ok(!out.includes('trip_brief'));
      assert.ok(!out.includes('rate limit') && !out.includes('credit balance'));
    }
  });
});

describe('TRAIL_SYSTEM_PROMPT', () => {
  test('is at most 9,000 characters and holds no backtick and no ${', () => {
    assert.ok(TRAIL_SYSTEM_PROMPT.length <= 9000, `${TRAIL_SYSTEM_PROMPT.length} characters`);
    assert.ok(!TRAIL_SYSTEM_PROMPT.includes('`'));
    assert.ok(!TRAIL_SYSTEM_PROMPT.includes('${'));
  });

  test('is the SPEC.md 5.4 text word for word, when SPEC.md is present', (t) => {
    let spec;
    try {
      spec = readFileSync(new URL('../../SPEC.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    } catch {
      t.skip('SPEC.md is gitignored and not present');
      return;
    }
    const fence = '`'.repeat(3);
    assert.ok(spec.includes(`${fence}text\n${TRAIL_SYSTEM_PROMPT}\n${fence}`));
  });
});
