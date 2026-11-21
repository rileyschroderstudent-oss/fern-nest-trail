// Session token tests (SPEC.md 4.8 and Task 6).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  issueSession,
  verifySession,
  signPayload,
  hasUsableSecret,
  base64urlEncode,
  base64urlDecode,
} from '../src/session.js';
import worker from '../src/index.js';

const ENV = { SESSION_SECRET: 'a'.repeat(64) };
const NOW = new Date('2026-11-22T03:00:00Z');
const later = (seconds) => new Date(NOW.getTime() + seconds * 1000);

const BRIEF = {
  destination: 'Vietnam', origin: 'Brisbane', travellers: 4, nights: 12, month: 7, year: 2027,
  budgetPerPersonAud: 3200, goal: 'best_value', pace: 'balanced', interests: 'food', notes: '',
};
const QUESTIONS = [
  { id: 'q1', text: 'Route shape?', why: 'Changes the stops.', options: [{ id: 'a', label: 'One line' }, { id: 'b', label: 'Two bases' }] },
  { id: 'q2', text: 'Rain?', why: 'Changes the season.', options: [{ id: 'a', label: 'Fine' }, { id: 'b', label: 'Avoid it' }] },
];

const issue = (fields = {}, env = ENV, now = NOW) =>
  issueSession(env, { stage: 'questions', brief: BRIEF, questions: QUESTIONS, ...fields }, now);

const decodePayload = (token) => JSON.parse(new TextDecoder().decode(base64urlDecode(token.split('.')[0])));

// Flips one base64url character to another valid one.
const flip = (c) => (c === 'A' ? 'B' : 'A');
const tamper = (part, i) => part.slice(0, i) + flip(part[i]) + part.slice(i + 1);

describe('base64url', () => {
  test('round-trips every byte value with no padding', () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    const text = base64urlEncode(bytes);
    assert.doesNotMatch(text, /[=+/]/);
    assert.deepEqual(base64urlDecode(text), bytes);
  });

  test('rejects characters outside the alphabet', () => {
    assert.throws(() => base64urlDecode('abc+'));
    assert.throws(() => base64urlDecode('ab=='));
  });
});

describe('issueSession and verifySession', () => {
  test('sign then verify round-trips', async () => {
    const token = await issue();
    const r = await verifySession(ENV, token, { stage: 'questions', now: NOW });
    assert.equal(r.ok, true);
    const p = r.payload;
    assert.equal(p.v, 1);
    assert.equal(p.stage, 'questions');
    assert.equal(p.revs, 0);
    assert.equal(p.exp - p.iat, 7200);
    assert.equal(p.iat, Math.floor(NOW.getTime() / 1000));
    assert.deepEqual(p.brief, BRIEF);
    assert.deepEqual(p.answers, []);
    assert.match(p.id, /^[0-9a-f]{32}$/);
  });

  test('the token format is base64url(payload).base64url(signature) with no padding', async () => {
    const token = await issue();
    assert.match(token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/); // 32-byte HMAC is 43 characters
  });

  test('every token gets a fresh id', async () => {
    const [a, b] = [decodePayload(await issue()), decodePayload(await issue())];
    assert.notEqual(a.id, b.id);
  });

  test('questions are stored without why', async () => {
    const p = decodePayload(await issue());
    assert.deepEqual(p.questions, [
      { id: 'q1', text: 'Route shape?', options: [{ id: 'a', label: 'One line' }, { id: 'b', label: 'Two bases' }] },
      { id: 'q2', text: 'Rain?', options: [{ id: 'a', label: 'Fine' }, { id: 'b', label: 'Avoid it' }] },
    ]);
  });

  test('a non-ASCII destination such as Hội An survives the round trip', async () => {
    const brief = { ...BRIEF, destination: 'Hội An', notes: 'Phở and 🌏, then Đà Lạt' };
    const token = await issue({ brief });
    const r = await verifySession(ENV, token, { stage: 'questions', now: NOW });
    assert.equal(r.ok, true);
    assert.equal(r.payload.brief.destination, 'Hội An');
    assert.equal(r.payload.brief.notes, 'Phở and 🌏, then Đà Lạt');
  });

  test('a changed payload fails', async () => {
    const [payload, sig] = (await issue()).split('.');
    for (const i of [0, 10, payload.length - 2]) {
      const r = await verifySession(ENV, `${tamper(payload, i)}.${sig}`, { stage: 'questions', now: NOW });
      assert.deepEqual(r, { ok: false, code: 'invalid_session' });
    }
  });

  test('a re-encoded payload with changed content fails', async () => {
    const [payload, sig] = (await issue()).split('.');
    const changed = { ...decodePayload(`${payload}.`), revs: 0, stage: 'plan' };
    const forged = base64urlEncode(new TextEncoder().encode(JSON.stringify(changed)));
    const r = await verifySession(ENV, `${forged}.${sig}`, { stage: 'plan', now: NOW });
    assert.deepEqual(r, { ok: false, code: 'invalid_session' });
  });

  test('a changed signature fails', async () => {
    const [payload, sig] = (await issue()).split('.');
    for (const i of [0, 20, 41]) {
      const r = await verifySession(ENV, `${payload}.${tamper(sig, i)}`, { stage: 'questions', now: NOW });
      assert.deepEqual(r, { ok: false, code: 'invalid_session' });
    }
  });

  test('a token signed with another secret fails', async () => {
    const token = await issue({}, { SESSION_SECRET: 'b'.repeat(64) });
    assert.deepEqual(await verifySession(ENV, token, { stage: 'questions', now: NOW }), { ok: false, code: 'invalid_session' });
  });

  test('an expired token gives session_expired', async () => {
    const token = await issue();
    assert.equal((await verifySession(ENV, token, { stage: 'questions', now: later(7200) })).ok, true);
    assert.deepEqual(await verifySession(ENV, token, { stage: 'questions', now: later(7201) }), { ok: false, code: 'session_expired' });
  });

  test('a forged expired token is invalid, not expired', async () => {
    const [payload] = (await issue()).split('.');
    const r = await verifySession(ENV, `${payload}.${'A'.repeat(43)}`, { stage: 'questions', now: later(9999) });
    assert.deepEqual(r, { ok: false, code: 'invalid_session' });
  });

  test('the wrong stage gives invalid_session', async () => {
    const token = await issue();
    assert.deepEqual(await verifySession(ENV, token, { stage: 'plan', now: NOW }), { ok: false, code: 'invalid_session' });
    const planToken = await issue({ stage: 'plan' });
    assert.deepEqual(await verifySession(ENV, planToken, { stage: 'questions', now: NOW }), { ok: false, code: 'invalid_session' });
  });

  test('malformed tokens give invalid_session', async () => {
    for (const token of [undefined, 42, '', 'dev', 'a.b.c', '.', 'abc.', '!!!.???']) {
      assert.deepEqual(await verifySession(ENV, token, { stage: 'questions', now: NOW }), { ok: false, code: 'invalid_session' });
    }
  });

  test('a signed payload of the wrong version or shape gives invalid_session', async () => {
    const good = decodePayload(await issue());
    for (const bad of [{ ...good, v: 2 }, { ...good, exp: 'later' }, { ...good, questions: null }, [1, 2]]) {
      const token = await signPayload(ENV, bad);
      assert.deepEqual(await verifySession(ENV, token, { stage: 'questions', now: NOW }), { ok: false, code: 'invalid_session' });
    }
  });
});

describe('SESSION_SECRET', () => {
  test('a secret shorter than 32 characters is not usable', () => {
    assert.equal(hasUsableSecret({ SESSION_SECRET: 'x'.repeat(31) }), false);
    assert.equal(hasUsableSecret({}), false);
    assert.equal(hasUsableSecret({ SESSION_SECRET: 'x'.repeat(32) }), true);
  });

  test('model routes return internal_error with a short secret, before any model call', async () => {
    const env = { ALLOWED_ORIGINS: 'http://localhost:8788', MODEL: 'claude-haiku-5-5', MOCK_ANTHROPIC: '1', SESSION_SECRET: 'short' };
    const res = await worker.fetch(new Request('http://localhost:8787/api/trail/start', {
      method: 'POST',
      headers: { Origin: 'http://localhost:8788', 'Content-Type': 'application/json' },
      body: JSON.stringify({ brief: BRIEF, turnstileToken: 'x' }),
    }), env, { waitUntil() {} });
    assert.equal(res.status, 500);
    assert.equal((await res.json()).error.code, 'internal_error');
  });
});

describe('router: /start and /plan with tokens', () => {
  const env = {
    ALLOWED_ORIGINS: 'http://localhost:8788',
    MODEL: 'claude-haiku-5-5',
    MOCK_ANTHROPIC: '1',
    SESSION_SECRET: ENV.SESSION_SECRET,
  };
  const post = (path, body) => worker.fetch(new Request(`http://localhost:8787${path}`, {
    method: 'POST',
    headers: { Origin: 'http://localhost:8788', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }), env, { waitUntil() {} });
  const start = async (destination) => (await post('/api/trail/start', {
    brief: { ...BRIEF, destination }, turnstileToken: 'x',
  })).json();
  const answersFor = (questions) => questions.map((q) => ({ questionId: q.id, optionId: q.options[0].id }));

  test('/plan returns a plan-stage token carrying the answers', async () => {
    const q = await start('Hội An');
    const res = await post('/api/trail/plan', { session: q.session, answers: answersFor(q.questions) });
    assert.equal(res.status, 200);
    const plan = await res.json();
    const r = await verifySession(env, plan.session, { stage: 'plan', now: new Date() });
    assert.equal(r.ok, true);
    assert.equal(r.payload.revs, 0);
    assert.equal(r.payload.brief.destination, 'Hội An');
    assert.deepEqual(r.payload.answers, answersFor(q.questions));
  });

  test('/plan uses the brief from the token', async () => {
    const q = await start('TEST-BANNED');
    const res = await post('/api/trail/plan', { session: q.session, answers: answersFor(q.questions) });
    assert.equal(res.status, 502);
    assert.equal((await res.json()).error.code, 'bad_model_output');
  });

  test('a plan-stage token cannot be used on /plan; a tampered one is invalid', async () => {
    const q = await start('Vietnam');
    const plan = await (await post('/api/trail/plan', { session: q.session, answers: answersFor(q.questions) })).json();
    const again = await post('/api/trail/plan', { session: plan.session, answers: answersFor(q.questions) });
    assert.equal(again.status, 401);
    assert.equal((await again.json()).error.code, 'invalid_session');
    const bad = await post('/api/trail/plan', { session: `x${q.session}`, answers: answersFor(q.questions) });
    assert.equal(bad.status, 401);
  });
});
