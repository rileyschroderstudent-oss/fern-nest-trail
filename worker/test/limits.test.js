// Limits, caps and the usage log (SPEC.md 4.8 and Task 8).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  decide,
  withTiming,
  limitsFor,
  ipHash,
  keysFor,
  countBurst,
  admit,
  settle,
  cleanup,
  costMicroUsd,
  demoStatus,
  outcomeOf,
  LIMIT_NAMES,
} from '../src/limits.js';
import * as C from '../src/config.js';
import worker from '../src/index.js';
import { createD1, testEnv, testCtx } from './d1.js';

const NOW = new Date('2026-11-22T03:04:05Z');
const LIMITS = limitsFor({});

// ---- decide ---------------------------------------------------------------------

describe('decide: each limit just under, at and over', () => {
  const CALL_LIMITS = [
    // [counter, limit name, stages it applies to, code, scope]
    ['trips', 'VISITOR_TRIPS_PER_DAY', ['start'], 'rate_limited', 'visitor_trips'],
    ['calls', 'VISITOR_CALLS_PER_DAY', ['start', 'plan', 'revise'], 'rate_limited', 'visitor_calls'],
    ['globalCallsDay', 'GLOBAL_DAILY_CALLS', ['start', 'plan', 'revise'], 'demo_closed', 'global_daily'],
    ['globalCallsMonth', 'GLOBAL_MONTHLY_CALLS', ['start', 'plan', 'revise'], 'demo_closed', 'global_monthly'],
  ];

  for (const [counter, name, stages, code, scope] of CALL_LIMITS) {
    const limit = LIMITS[name];
    for (const stage of stages) {
      test(`${counter} on ${stage}: ${limit - 1} admits, ${limit} and ${limit + 1} refuse`, () => {
        assert.deepEqual(decide({ [counter]: limit - 1 }, stage, LIMITS), { ok: true });
        assert.deepEqual(decide({ [counter]: limit }, stage, LIMITS), { ok: false, code, scope });
        assert.deepEqual(decide({ [counter]: limit + 1 }, stage, LIMITS), { ok: false, code, scope });
      });
    }
  }

  test('the trips limit does not apply to plan or revise', () => {
    for (const stage of ['plan', 'revise']) {
      assert.deepEqual(decide({ trips: 99 }, stage, LIMITS), { ok: true });
    }
  });

  test('the spec numbers: 3 trips, 12 calls, 120 and 1,500 global calls', () => {
    assert.deepEqual(
      [LIMITS.VISITOR_TRIPS_PER_DAY, LIMITS.VISITOR_CALLS_PER_DAY, LIMITS.GLOBAL_DAILY_CALLS, LIMITS.GLOBAL_MONTHLY_CALLS],
      [3, 12, 120, 1500],
    );
  });
});

describe('decide: the dollar caps', () => {
  const DOLLAR_CAPS = [
    ['globalUsdDay', 'GLOBAL_DAILY_MICRO_USD', 350000, 'global_daily'],
    ['globalUsdMonth', 'GLOBAL_MONTHLY_MICRO_USD', 4500000, 'global_monthly'],
  ];
  for (const [counter, name, cap, scope] of DOLLAR_CAPS) {
    test(`${counter}: admits while spend is under ${cap} micro-dollars, refuses at and over`, () => {
      assert.equal(LIMITS[name], cap);
      for (const stage of ['start', 'plan', 'revise']) {
        assert.deepEqual(decide({ [counter]: cap - 1 }, stage, LIMITS), { ok: true });
        assert.deepEqual(decide({ [counter]: cap }, stage, LIMITS), { ok: false, code: 'demo_closed', scope });
        assert.deepEqual(decide({ [counter]: cap + 1 }, stage, LIMITS), { ok: false, code: 'demo_closed', scope });
      }
    });
  }

  test('a closed demo wins over a visitor limit, and the monthly cap over the daily one', () => {
    const all = { trips: 9, calls: 99, globalUsdDay: 350000, globalUsdMonth: 4500000 };
    assert.equal(decide(all, 'start', LIMITS).scope, 'global_monthly');
    assert.equal(decide({ ...all, globalUsdMonth: 0 }, 'start', LIMITS).scope, 'global_daily');
  });

  test('missing values count as zero', () => {
    assert.deepEqual(decide({}, 'start', LIMITS), { ok: true });
  });

  test('stage status checks the global caps only', () => {
    assert.deepEqual(decide({ trips: 9, calls: 99 }, 'status', LIMITS), { ok: true });
    assert.equal(decide({ globalCallsDay: 120 }, 'status', LIMITS).scope, 'global_daily');
  });
});

describe('withTiming', () => {
  test('a burst retries at the next minute; a daily limit at the next 00:00 UTC', () => {
    assert.equal(withTiming({ scope: 'burst' }, NOW).retryAfterSeconds, 55);
    const toMidnight = (24 * 3600) - (3 * 3600 + 4 * 60 + 5);
    assert.equal(withTiming({ scope: 'visitor_trips' }, NOW).retryAfterSeconds, toMidnight);
    assert.equal(withTiming({ scope: 'visitor_calls' }, NOW).retryAfterSeconds, toMidnight);
  });

  test('the daily cap reopens at the next UTC midnight; the monthly cap on the 1st', () => {
    assert.equal(withTiming({ scope: 'global_daily' }, NOW).reopensAt, '2026-11-23T00:00:00Z');
    assert.equal(withTiming({ scope: 'global_monthly' }, NOW).reopensAt, '2026-12-01T00:00:00Z');
    assert.equal(withTiming({ scope: 'global_monthly' }, new Date('2026-12-31T23:59:59Z')).reopensAt, '2027-01-01T00:00:00Z');
  });

  test('a retry is never zero seconds', () => {
    assert.equal(withTiming({ scope: 'burst' }, new Date('2026-11-22T03:04:59.999Z')).retryAfterSeconds, 1);
  });
});

// ---- LIMIT_OVERRIDES ----------------------------------------------------------------

describe('limitsFor: LIMIT_OVERRIDES', () => {
  test('replaces the named constants in mock mode', () => {
    const l = limitsFor({ MOCK_ANTHROPIC: '1', LIMIT_OVERRIDES: '{"GLOBAL_DAILY_CALLS":2,"VISITOR_TRIPS_PER_DAY":50}' });
    assert.equal(l.GLOBAL_DAILY_CALLS, 2);
    assert.equal(l.VISITOR_TRIPS_PER_DAY, 50);
    assert.equal(l.GLOBAL_MONTHLY_CALLS, 1500);
  });

  test('is ignored when MOCK_ANTHROPIC is not 1', () => {
    for (const mock of ['0', undefined, 'true']) {
      const l = limitsFor({ MOCK_ANTHROPIC: mock, LIMIT_OVERRIDES: '{"GLOBAL_DAILY_CALLS":2}' });
      assert.equal(l.GLOBAL_DAILY_CALLS, 120);
    }
  });

  test('ignores unknown names, bad values and unreadable JSON', () => {
    const base = limitsFor({});
    for (const raw of ['{"PRICES":0,"GLOBAL_DAILY_CALLS":-1}', '{"GLOBAL_DAILY_CALLS":"2"}', '{"GLOBAL_DAILY_CALLS":2.5}', 'not json', '[1]', 'null']) {
      assert.deepEqual(limitsFor({ MOCK_ANTHROPIC: '1', LIMIT_OVERRIDES: raw }), base);
    }
  });

  test('every limit name is a constant in config.js', () => {
    for (const name of LIMIT_NAMES) assert.equal(typeof C[name], 'number', name);
  });
});

// ---- ipHash and keys ------------------------------------------------------------------

describe('ipHash and counter keys', () => {
  const env = { IP_HASH_SALT: 'salt' };

  test('is the first 24 hex characters of SHA-256 over salt|date|ip', async () => {
    const h = await ipHash(env, '203.0.113.7', NOW);
    assert.match(h, /^[0-9a-f]{24}$/);
    const expected = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('salt|2026-11-22|203.0.113.7')));
    assert.equal(h, Array.from(expected, (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 24));
  });

  test('changes with the day, the salt and the IP, so it cannot follow a visitor across days', async () => {
    const h = await ipHash(env, '203.0.113.7', NOW);
    assert.notEqual(h, await ipHash(env, '203.0.113.7', new Date('2026-11-23T03:04:05Z')));
    assert.notEqual(h, await ipHash({ IP_HASH_SALT: 'other' }, '203.0.113.7', NOW));
    assert.notEqual(h, await ipHash(env, '203.0.113.8', NOW));
    assert.equal(h, await ipHash(env, '203.0.113.7', new Date('2026-11-22T23:59:59Z')));
  });

  test('keys follow the 4.8 table', () => {
    assert.deepEqual(keysFor('abc', NOW), {
      burst: 'ip:abc:min:202611220304',
      trips: 'ip:abc:trips:20261122',
      calls: 'ip:abc:calls:20261122',
      globalCallsDay: 'g:calls:d:20261122',
      globalUsdDay: 'g:usd:d:20261122',
      globalCallsMonth: 'g:calls:m:202611',
      globalUsdMonth: 'g:usd:m:202611',
    });
  });
});

// ---- Counters in a database -------------------------------------------------------------

describe('countBurst, admit, settle and cleanup', () => {
  test('countBurst admits 10 POSTs a minute and rejects the 11th, counting rejected ones', async () => {
    const env = { DB: createD1() };
    for (let i = 1; i <= 10; i++) assert.deepEqual(await countBurst(env, 'h', NOW, LIMITS), { ok: true });
    const r = await countBurst(env, 'h', NOW, LIMITS);
    assert.deepEqual(r, { ok: false, code: 'rate_limited', scope: 'burst', retryAfterSeconds: 55 });
    await countBurst(env, 'h', NOW, LIMITS);
    assert.equal(env.DB.counter(keysFor('h', NOW).burst), 12);
    // The next minute starts again.
    assert.deepEqual(await countBurst(env, 'h', new Date('2026-11-22T03:05:00Z'), LIMITS), { ok: true });
  });

  test('admit writes the trip and call counters; the 4th trip is refused', async () => {
    const env = { DB: createD1() };
    const k = keysFor('h', NOW);
    for (let i = 0; i < 3; i++) assert.deepEqual(await admit(env, 'h', 'start', NOW, LIMITS), { ok: true });
    assert.equal(env.DB.counter(k.trips), 3);
    assert.equal(env.DB.counter(k.calls), 3);
    assert.equal(env.DB.counter(k.globalCallsDay), 3);
    assert.equal(env.DB.counter(k.globalCallsMonth), 3);
    const r = await admit(env, 'h', 'start', NOW, LIMITS);
    assert.equal(r.code, 'rate_limited');
    assert.equal(r.scope, 'visitor_trips');
    assert.equal(env.DB.counter(k.trips), 3); // a refused call writes nothing
    // A plan call still has calls left.
    assert.deepEqual(await admit(env, 'h', 'plan', NOW, LIMITS), { ok: true });
    assert.equal(env.DB.counter(k.trips), 3);
    assert.equal(env.DB.counter(k.calls), 4);
  });

  test('counters expire on the 4.8 schedule', async () => {
    const env = { DB: createD1() };
    await countBurst(env, 'h', NOW, LIMITS);
    await admit(env, 'h', 'start', NOW, LIMITS);
    const t = Math.floor(NOW.getTime() / 1000);
    const expiry = Object.fromEntries(env.DB.rows('SELECT key, expires_at FROM counters').map((r) => [r.key.split(':').slice(0, 3).join(':'), r.expires_at - t]));
    assert.equal(expiry['ip:h:min'], 120);
    assert.equal(expiry['ip:h:trips'], 2 * 86400);
    assert.equal(expiry['g:calls:d'], 2 * 86400);
    assert.equal(expiry['g:calls:m'], 40 * 86400);
  });

  test('settle adds the cost to both dollar counters and writes one usage_log row', async () => {
    const env = { DB: createD1() };
    const record = { stage: 'plan', model: 'claude-haiku-5-5', usage: { input_tokens: 4150, output_tokens: 4500 }, duration_ms: 312.4, outcome: 'ok' };
    assert.equal(await settle(env, record, NOW), 2665);
    const k = keysFor('', NOW);
    assert.equal(env.DB.counter(k.globalUsdDay), 2665);
    assert.equal(env.DB.counter(k.globalUsdMonth), 2665);
    assert.deepEqual(env.DB.rows('SELECT ts, stage, model, input_tokens, output_tokens, cost_micro_usd, duration_ms, outcome FROM usage_log'), [{
      ts: Math.floor(NOW.getTime() / 1000), stage: 'plan', model: 'claude-haiku-5-5',
      input_tokens: 4150, output_tokens: 4500, cost_micro_usd: 2665, duration_ms: 312, outcome: 'ok',
    }]);
  });

  test('a zero-cost call leaves the dollar counters untouched but is still logged', async () => {
    const env = { DB: createD1() };
    await settle(env, { stage: 'plan', model: 'claude-haiku-5-5', usage: { input_tokens: 0, output_tokens: 0 }, duration_ms: 5, outcome: 'upstream_busy' }, NOW);
    assert.equal(env.DB.rows('SELECT * FROM counters').length, 0);
    assert.equal(env.DB.rows('SELECT outcome FROM usage_log')[0].outcome, 'upstream_busy');
  });

  test('the usage_log row holds no trip content and no IP data', () => {
    const columns = createD1().rows('PRAGMA table_info(usage_log)').map((c) => c.name);
    assert.deepEqual(columns, ['id', 'ts', 'stage', 'model', 'input_tokens', 'output_tokens', 'cost_micro_usd', 'duration_ms', 'outcome']);
  });

  test('cleanup deletes expired counters and log rows older than 90 days', async () => {
    const env = { DB: createD1() };
    const t = Math.floor(NOW.getTime() / 1000);
    env.DB.rows("INSERT INTO counters VALUES ('old', 1, ?), ('live', 1, ?) RETURNING key", t - 1, t + 60);
    env.DB.rows("INSERT INTO usage_log (ts, stage, model, input_tokens, output_tokens, cost_micro_usd, duration_ms, outcome) VALUES (?, 'plan', 'm', 0, 0, 0, 0, 'ok'), (?, 'plan', 'm', 0, 0, 0, 0, 'ok') RETURNING id",
      t - 91 * 86400, t - 89 * 86400);
    await cleanup(env, NOW);
    assert.deepEqual(env.DB.rows('SELECT key FROM counters').map((r) => r.key), ['live']);
    assert.equal(env.DB.rows('SELECT id FROM usage_log').length, 1);
  });
});

// ---- Cost and outcomes ------------------------------------------------------------------

describe('costMicroUsd', () => {
  test('mock usage costs 705 and 2,665 micro-dollars on Haiku 5.5', () => {
    assert.equal(costMicroUsd('claude-haiku-5-5', { input_tokens: 3050, output_tokens: 800 }), 705);
    assert.equal(costMicroUsd('claude-haiku-5-5', { input_tokens: 4150, output_tokens: 4500 }), 2665);
  });

  test('matches exact integer arithmetic across a range of token counts', () => {
    // Prices are scaled to integers first (Task 8: integer maths only).
    for (const [i, o] of [[0, 0], [1, 1], [9, 1], [3050, 800], [99999, 7999], [123457, 8000]]) {
      const exact = Math.ceil((i * 100000 + o * 500000) / 1e6);
      assert.equal(costMicroUsd('claude-haiku-5-5', { input_tokens: i, output_tokens: o }), exact);
      assert.ok(Number.isInteger(costMicroUsd('claude-haiku-5-5', { input_tokens: i, output_tokens: o })));
    }
  });

  test('rounds a part micro-dollar up, and prices Sonnet 5.5', () => {
    assert.equal(costMicroUsd('claude-haiku-5-5', { input_tokens: 1, output_tokens: 0 }), 1);
    assert.equal(costMicroUsd('claude-sonnet-5-5', { input_tokens: 4150, output_tokens: 4500 }), 53300);
  });

  test('refuses an unpriced model', () => {
    assert.throws(() => costMicroUsd('claude-unknown', { input_tokens: 1, output_tokens: 1 }));
  });
});

describe('outcomeOf', () => {
  test('maps every model result to a 4.8 outcome', () => {
    assert.equal(outcomeOf('ok', { ok: true, value: { questions: [] } }), 'ok');
    assert.equal(outcomeOf('ok', { ok: true, value: { type: 'declined', reason: 'not_travel' } }), 'declined');
    assert.equal(outcomeOf('ok', { ok: false, outcome: 'invalid_questions' }), 'invalid_questions');
    assert.equal(outcomeOf('ok', { ok: false, outcome: 'invalid_plan' }), 'invalid_plan');
    assert.equal(outcomeOf('ok', { ok: false, outcome: 'banned_phrase' }), 'banned_phrase');
    for (const kind of ['refusal', 'truncated', 'invalid_json', 'demo_closed', 'upstream_busy', 'upstream_error']) {
      assert.equal(outcomeOf(kind, null), kind);
    }
    assert.equal(outcomeOf('internal_error', null), 'upstream_error');
  });
});

// ---- Through the router -------------------------------------------------------------------

const BRIEF = {
  destination: 'Vietnam', origin: 'Brisbane', travellers: 4, nights: 12, month: 7, year: 2027,
  budgetPerPersonAud: 3200, goal: 'best_value', pace: 'balanced', interests: 'food', notes: '',
};

function client(env) {
  const ctx = testCtx();
  const call = async (method, path, body) => {
    const res = await worker.fetch(new Request(`http://localhost:8787${path}`, {
      method,
      headers: { Origin: 'http://localhost:8788', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), env, ctx);
    await ctx.flush();
    return { status: res.status, headers: res.headers, body: await res.json() };
  };
  const start = (destination = 'Vietnam') => call('POST', '/api/trail/start', { brief: { ...BRIEF, destination }, turnstileToken: 'x' });
  const plan = (q) => call('POST', '/api/trail/plan', {
    session: q.session,
    answers: q.questions.map((x) => ({ questionId: x.id, optionId: x.options[0].id })),
  });
  return { call, start, plan, status: () => call('GET', '/api/status') };
}

const today = () => keysFor('', new Date());

describe('router: limits end to end (mock mode)', () => {
  test('one /start and one /plan log rows costing 705 and 2,665; g:usd:d rises by 3,370', async () => {
    const env = testEnv();
    const c = client(env);
    const q = await c.start();
    assert.equal(q.status, 200);
    assert.equal((await c.plan(q.body)).status, 200);
    assert.deepEqual(env.DB.rows('SELECT stage, cost_micro_usd, outcome FROM usage_log ORDER BY id'), [
      { stage: 'start', cost_micro_usd: 705, outcome: 'ok' },
      { stage: 'plan', cost_micro_usd: 2665, outcome: 'ok' },
    ]);
    assert.equal(env.DB.counter(today().globalUsdDay), 3370);
    assert.equal(env.DB.counter(today().globalUsdMonth), 3370);
  });

  test('the 4th /start in a day returns 429 with a Retry-After header', async () => {
    const env = testEnv();
    const c = client(env);
    for (let i = 0; i < 3; i++) assert.equal((await c.start()).status, 200);
    const fourth = await c.start();
    assert.equal(fourth.status, 429);
    assert.equal(fourth.body.error.code, 'rate_limited');
    assert.ok(fourth.body.error.retryAfterSeconds > 0);
    assert.equal(fourth.headers.get('Retry-After'), String(fourth.body.error.retryAfterSeconds));
  });

  test('the 11th POST in a minute returns 429, even when the earlier ones were rejected', async () => {
    const env = testEnv();
    const c = client(env);
    for (let i = 0; i < 10; i++) {
      const r = await c.call('POST', '/api/trail/plan', { session: 'bad', answers: [] });
      assert.equal(r.status, 401);
    }
    const eleventh = await c.call('POST', '/api/trail/plan', { session: 'bad', answers: [] });
    assert.equal(eleventh.status, 429);
    assert.ok(Number(eleventh.headers.get('Retry-After')) >= 1);
  });

  test('with GLOBAL_DAILY_CALLS of 2 the third model call returns 503 and status shows daily_cap', async () => {
    const env = testEnv({ LIMIT_OVERRIDES: '{"GLOBAL_DAILY_CALLS":2}' });
    const c = client(env);
    const q = await c.start();
    assert.equal((await c.plan(q.body)).status, 200);
    const third = await c.start();
    assert.equal(third.status, 503);
    assert.equal(third.body.error.code, 'demo_closed');
    const d = new Date();
    const midnight = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));
    assert.equal(third.body.error.reopensAt, midnight.toISOString().replace('.000Z', 'Z'));
    const s = await c.status();
    assert.equal(s.body.open, false);
    assert.equal(s.body.reason, 'daily_cap');
    assert.equal(s.body.reopensAt, third.body.error.reopensAt);
  });

  test('LIMIT_OVERRIDES does nothing outside mock mode', async () => {
    const env = testEnv({ MOCK_ANTHROPIC: '0', LIMIT_OVERRIDES: '{"GLOBAL_DAILY_CALLS":0}' });
    const s = await client(env).status();
    assert.equal(s.body.open, true);
  });

  test('with DEMO_ENABLED=0 model routes return 503 and status shows paused', async () => {
    const env = testEnv({ DEMO_ENABLED: '0' });
    const c = client(env);
    const r = await c.start();
    assert.equal(r.status, 503);
    assert.equal(r.body.error.code, 'demo_closed');
    assert.equal(r.body.error.reopensAt, null);
    assert.deepEqual((await c.status()).body, {
      ...(await client(testEnv()).status()).body, open: false, reason: 'paused', reopensAt: null,
    });
    assert.equal(env.DB.rows('SELECT * FROM counters').length, 0); // the kill switch is checked before the burst counter
  });

  test('after TEST-BUSY the dollar counters are unchanged, the call counters are up by one, and the token works again', async () => {
    const env = testEnv();
    const c = client(env);
    const q = await c.start('TEST-BUSY');
    assert.equal(q.status, 502);
    assert.equal(q.body.error.code, 'upstream_busy');
    const k = today();
    assert.equal(env.DB.counter(k.globalUsdDay), 0);
    assert.equal(env.DB.counter(k.globalCallsDay), 1);
    assert.equal(env.DB.rows('SELECT outcome, cost_micro_usd FROM usage_log')[0].outcome, 'upstream_busy');

    // At the plan stage: a busy plan call leaves the token usable.
    const ok = await c.start('Vietnam');
    const before = { usd: env.DB.counter(k.globalUsdDay), calls: env.DB.counter(k.globalCallsDay) };
    const brief = { ...BRIEF, destination: 'TEST-BUSY' };
    const { issueSession } = await import('../src/session.js');
    const session = await issueSession(env, { stage: 'questions', brief, questions: ok.body.questions }, new Date());
    const busy = await c.plan({ session, questions: ok.body.questions });
    assert.equal(busy.status, 502);
    assert.equal(env.DB.counter(k.globalUsdDay), before.usd);
    assert.equal(env.DB.counter(k.globalCallsDay), before.calls + 1);
    const again = await c.plan({ session, questions: ok.body.questions });
    assert.equal(again.status, 502); // still TEST-BUSY, but the token was accepted again, not 401
    assert.equal(again.body.error.code, 'upstream_busy');
  });

  test('status reports the overridden trip limit and is open by default', async () => {
    const s = await client(testEnv({ LIMIT_OVERRIDES: '{"VISITOR_TRIPS_PER_DAY":5}' })).status();
    assert.equal(s.body.open, true);
    assert.equal(s.body.limits.tripsPerVisitorPerDay, 5);
  });

  test('a refused admission is not logged and costs nothing', async () => {
    const env = testEnv({ LIMIT_OVERRIDES: '{"VISITOR_TRIPS_PER_DAY":0}' });
    const r = await client(env).start();
    assert.equal(r.status, 429);
    assert.equal(env.DB.rows('SELECT * FROM usage_log').length, 0);
  });

  test('/start deletes expired counters', async () => {
    const env = testEnv();
    env.DB.rows("INSERT INTO counters VALUES ('stale', 1, 0) RETURNING key");
    await client(env).start();
    assert.equal(env.DB.counter('stale'), 0);
  });
});

describe('demoStatus', () => {
  test('monthly cap wins and reopens on the 1st', async () => {
    const env = { DB: createD1() };
    const k = keysFor('', NOW);
    env.DB.rows('INSERT INTO counters VALUES (?, ?, ?) RETURNING key', k.globalUsdMonth, 4500000, 9e9);
    assert.deepEqual(await demoStatus(env, NOW, LIMITS), { open: false, reason: 'monthly_cap', reopensAt: '2026-12-01T00:00:00Z' });
  });
});
