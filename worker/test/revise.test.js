// /api/trail/revise tests (SPEC.md 4.4, 4.8 and Task 11), in mock mode.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import worker from '../src/index.js';
import { verifySession, issueSession } from '../src/session.js';
import { buildMessage } from '../src/messages.js';
import { testEnv, testCtx } from './d1.js';

const BRIEF = {
  destination: 'Vietnam', origin: 'Brisbane', travellers: 4, nights: 12, month: 7, year: 2027,
  budgetPerPersonAud: 3200, goal: 'best_value', pace: 'balanced', interests: 'food', notes: '',
};

function client(env = testEnv()) {
  const ctx = testCtx();
  const post = async (path, body, raw) => {
    const res = await worker.fetch(new Request(`http://localhost:8787${path}`, {
      method: 'POST',
      headers: { Origin: 'http://localhost:8788', 'Content-Type': 'application/json' },
      body: raw ?? JSON.stringify(body),
    }), env, ctx);
    await ctx.flush();
    return { status: res.status, body: await res.json() };
  };
  return {
    env,
    post,
    async trip(destination = 'Vietnam') {
      const q = (await post('/api/trail/start', { brief: { ...BRIEF, destination }, turnstileToken: 'x' })).body;
      const answers = q.questions.map((x) => ({ questionId: x.id, optionId: x.options[0].id }));
      return (await post('/api/trail/plan', { session: q.session, answers })).body;
    },
    revise: (plan, request = 'Make it cheaper and drop Ha Long Bay') =>
      post('/api/trail/revise', { session: plan.session, plan: plan.plan, request }),
  };
}

describe('/api/trail/revise', () => {
  test('two revisions succeed and a third returns 409 revisions_exhausted', async () => {
    const c = client();
    const plan = await c.trip();
    assert.equal(plan.revisionsLeft, 2);

    const first = await c.revise(plan);
    assert.equal(first.status, 200);
    assert.equal(first.body.type, 'plan');
    assert.equal(first.body.revisionsLeft, 1);

    const second = await c.revise(first.body);
    assert.equal(second.status, 200);
    assert.equal(second.body.revisionsLeft, 0);

    const third = await c.revise(second.body);
    assert.equal(third.status, 409);
    assert.equal(third.body.error.code, 'revisions_exhausted');
  });

  test('a body over 64 KB returns 400', async () => {
    const c = client();
    const plan = await c.trip();
    const big = { ...plan.plan, honest_take: 'x'.repeat(64 * 1024) };
    const r = await c.post('/api/trail/revise', { session: plan.session, plan: big, request: 'Cheaper please' });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'invalid_input');
    assert.deepEqual(r.body.error.fields, [{ name: 'body', problem: 'too_large' }]);
  });

  test('a body between 16 and 64 KB is accepted', async () => {
    const c = client();
    const plan = await c.trip();
    const bigger = { ...plan.plan, honest_take: 'x'.repeat(30 * 1024) };
    assert.equal((await c.post('/api/trail/revise', { session: plan.session, plan: bigger, request: 'Cheaper please' })).status, 200);
  });

  test('mock revise returns the plan fixture with " (revised)" added to the title', async () => {
    const c = client();
    const plan = await c.trip();
    const r = await c.revise(plan);
    assert.equal(r.body.plan.title, `${plan.plan.title} (revised)`);
    assert.ok(r.body.plan.budget_items.every((it) => it.kind === 'estimate'));
    assert.deepEqual(r.body.warnings, []);
  });

  test('revs in the token is the source of truth, and the new token keeps the trip', async () => {
    const c = client();
    const plan = await c.trip('Hội An');
    const first = await c.revise(plan);
    const r = await verifySession(c.env, first.body.session, { stage: 'plan', now: new Date() });
    assert.equal(r.ok, true);
    assert.equal(r.payload.revs, 1);
    assert.equal(r.payload.brief.destination, 'Hội An');
    assert.equal(r.payload.answers.length, 4);

    // Reusing the first plan token after a revision still counts from its own revs.
    const again = await c.revise(plan);
    assert.equal(again.body.revisionsLeft, 1);
  });

  test('a questions-stage token, a tampered token or an expired one is refused', async () => {
    const c = client();
    const q = (await c.post('/api/trail/start', { brief: BRIEF, turnstileToken: 'x' })).body;
    const plan = await c.trip();
    const wrongStage = await c.post('/api/trail/revise', { session: q.session, plan: plan.plan, request: 'Cheaper please' });
    assert.equal(wrongStage.status, 401);
    assert.equal(wrongStage.body.error.code, 'invalid_session');

    const tampered = await c.post('/api/trail/revise', { session: `${plan.session}x`, plan: plan.plan, request: 'Cheaper please' });
    assert.equal(tampered.status, 401);

    const old = new Date(Date.now() - 3 * 3600 * 1000);
    const expiredToken = await issueSession(c.env, { stage: 'plan', revs: 0, brief: BRIEF, questions: [], answers: [] }, old);
    const expired = await c.post('/api/trail/revise', { session: expiredToken, plan: plan.plan, request: 'Cheaper please' });
    assert.equal(expired.status, 410);
    assert.equal(expired.body.error.code, 'session_expired');
  });

  test('a change request under 3 or over 300 characters after cleaning returns 400', async () => {
    const c = client();
    const plan = await c.trip();
    for (const [request, problem] of [['  <a>  ', 'too_short'], ['x'.repeat(301), 'too_long']]) {
      const r = await c.revise(plan, request);
      assert.equal(r.status, 400);
      assert.deepEqual(r.body.error.fields, [{ name: 'request', problem }]);
    }
  });

  test('a revise call is admitted, priced and logged at the revise stage', async () => {
    const c = client();
    const plan = await c.trip();
    await c.revise(plan);
    const last = c.env.DB.rows('SELECT stage, cost_micro_usd, outcome FROM usage_log ORDER BY id DESC LIMIT 1')[0];
    assert.deepEqual(last, { stage: 'revise', cost_micro_usd: 2665, outcome: 'ok' });
  });

  test('a refused revision (409) uses no call and is not logged', async () => {
    const c = client();
    const plan = await c.trip();
    const two = await c.revise((await c.revise(plan)).body);
    const before = c.env.DB.rows('SELECT COUNT(*) AS n FROM usage_log')[0].n;
    assert.equal((await c.revise(two.body)).status, 409);
    assert.equal(c.env.DB.rows('SELECT COUNT(*) AS n FROM usage_log')[0].n, before);
  });

  test('TEST-BANNED at the revise stage returns 502 bad_model_output', async () => {
    const c = client();
    const plan = await c.trip('Vietnam');
    // Re-sign a plan token whose brief is TEST-BANNED, as a plan for that brief would carry.
    const payload = (await verifySession(c.env, plan.session, { stage: 'plan', now: new Date() })).payload;
    const session = await issueSession(c.env, { ...payload, brief: { ...payload.brief, destination: 'TEST-BANNED' } }, new Date());
    const r = await c.post('/api/trail/revise', { session, plan: plan.plan, request: 'Cheaper please' });
    assert.equal(r.status, 502);
    assert.equal(r.body.error.code, 'bad_model_output');
  });
});

describe('the revise message', () => {
  test('carries the plan as sent and the cleaned change request', () => {
    const msg = buildMessage('revise', {
      brief: BRIEF,
      questions: [{ id: 'q1', text: 'Route?', options: [{ id: 'a', label: 'Loop' }] }],
      answers: [{ questionId: 'q1', optionId: 'a' }],
      plan: { title: 'T' },
      request: 'Drop Ha Long Bay',
    }, new Date('2026-11-22T00:00:00Z'));
    assert.match(msg, /^STAGE: revise$/m);
    assert.match(msg, /<current_plan>\n\{"title":"T"\}\n<\/current_plan>/);
    assert.match(msg, /<change_request>\nDrop Ha Long Bay\n<\/change_request>\nRewrite the whole plan with the change applied\.$/);
  });
});
