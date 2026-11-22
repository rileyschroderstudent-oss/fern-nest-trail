// Turnstile tests (SPEC.md Task 9). Every call uses a fake fetch.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { verifyTurnstile } from '../src/turnstile.js';
import worker from '../src/index.js';
import { testEnv, testCtx, TURNSTILE_FAIL_SECRET, TURNSTILE_DUMMY_TOKEN } from './d1.js';
import { keysFor } from '../src/limits.js';

const PROD = {
  TURNSTILE_SECRET_KEY: 'real-secret',
  MOCK_ANTHROPIC: '0',
  ALLOWED_ORIGINS: 'https://rileyschroderstudent-oss.github.io',
};
const MOCK = { ...PROD, MOCK_ANTHROPIC: '1', ALLOWED_ORIGINS: 'http://localhost:8788' };

function fakeFetch(respond) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init, form: new URLSearchParams(init.body) });
    return respond();
  };
  impl.calls = calls;
  return impl;
}
const reply = (body, status = 200) => () => new Response(JSON.stringify(body), { status });

describe('verifyTurnstile', () => {
  test('success: POSTs secret, response and remoteip to siteverify', async () => {
    const f = fakeFetch(reply({ success: true, hostname: 'rileyschroderstudent-oss.github.io' }));
    assert.equal(await verifyTurnstile(PROD, 'tok', '203.0.113.7', f), true);
    const [{ url, init, form }] = f.calls;
    assert.equal(url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
    assert.equal(init.method, 'POST');
    assert.deepEqual(Object.fromEntries(form), { secret: 'real-secret', response: 'tok', remoteip: '203.0.113.7' });
    assert.ok(init.signal instanceof AbortSignal);
  });

  test('remoteip is left out when the IP is unknown', async () => {
    const f = fakeFetch(reply({ success: true }));
    await verifyTurnstile(MOCK, 'tok', null, f);
    assert.equal(f.calls[0].form.has('remoteip'), false);
  });

  test('failure: success false, or success missing or not true', async () => {
    for (const body of [{ success: false, 'error-codes': ['invalid-input-response'] }, {}, { success: 'true' }, null]) {
      assert.equal(await verifyTurnstile(MOCK, 'tok', null, fakeFetch(reply(body))), false);
    }
  });

  test('a network error, a timeout, a non-200 reply or unreadable JSON fails', async () => {
    const throws = (err) => fakeFetch(() => { throw err; });
    assert.equal(await verifyTurnstile(MOCK, 'tok', null, throws(new TypeError('fetch failed'))), false);
    assert.equal(await verifyTurnstile(MOCK, 'tok', null, throws(new DOMException('timed out', 'TimeoutError'))), false);
    assert.equal(await verifyTurnstile(MOCK, 'tok', null, fakeFetch(reply({ success: true }, 500))), false);
    assert.equal(await verifyTurnstile(MOCK, 'tok', null, fakeFetch(() => new Response('<html>'))), false);
  });

  test('outside mock mode the hostname must belong to an allowed origin', async () => {
    const check = (hostname) => verifyTurnstile(PROD, 'tok', null, fakeFetch(reply({ success: true, hostname })));
    assert.equal(await check('rileyschroderstudent-oss.github.io'), true);
    assert.equal(await check('example.com'), false);
    assert.equal(await check('evil.github.io'), false);
    assert.equal(await check(undefined), false);
  });

  test('in mock mode the hostname is not checked (test keys report example.com)', async () => {
    assert.equal(await verifyTurnstile(MOCK, 'tok', null, fakeFetch(reply({ success: true, hostname: 'example.com' }))), true);
  });

  test('an empty token never calls siteverify', async () => {
    const f = fakeFetch(reply({ success: true }));
    assert.equal(await verifyTurnstile(MOCK, '', null, f), false);
    assert.equal(f.calls.length, 0);
  });
});

describe('router: /start and the bot check', () => {
  const BRIEF = {
    destination: 'Vietnam', origin: 'Brisbane', travellers: 4, nights: 12, month: 7, year: 2027,
    budgetPerPersonAud: 3200, goal: 'best_value', pace: 'balanced', interests: 'food', notes: '',
  };
  const start = async (env) => {
    const ctx = testCtx();
    const res = await worker.fetch(new Request('http://localhost:8787/api/trail/start', {
      method: 'POST',
      headers: { Origin: 'http://localhost:8788', 'Content-Type': 'application/json' },
      body: JSON.stringify({ brief: BRIEF, turnstileToken: TURNSTILE_DUMMY_TOKEN }),
    }), env, ctx);
    await ctx.flush();
    return { status: res.status, body: await res.json() };
  };

  test('the always-pass test secret lets /start through', async () => {
    assert.equal((await start(testEnv())).status, 200);
  });

  test('the always-fail secret returns 403 challenge_failed and only the minute counter changes', async () => {
    const env = testEnv({ TURNSTILE_SECRET_KEY: TURNSTILE_FAIL_SECRET });
    const r = await start(env);
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'challenge_failed');
    const keys = env.DB.rows('SELECT key FROM counters').map((x) => x.key);
    assert.equal(keys.length, 1);
    assert.match(keys[0], /^ip:[0-9a-f]{24}:min:\d{12}$/);
    assert.equal(env.DB.rows('SELECT * FROM usage_log').length, 0);
    assert.equal(env.DB.counter(keysFor('', new Date()).globalCallsDay), 0);
  });

  test('a missing secret is a server error, not a failed check', async () => {
    const r = await start(testEnv({ TURNSTILE_SECRET_KEY: '' }));
    assert.equal(r.status, 500);
    assert.equal(r.body.error.code, 'internal_error');
  });
});
