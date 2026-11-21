// Input validation tests (SPEC.md 4.7 "Input: the brief" and Task 5).
// Each field is tested at its minimum, its maximum, one step outside each, and the
// wrong type. `now` is fixed so the year and past-month rules are deterministic.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  cleanString,
  validateBrief,
  validateAnswers,
  validateRevision,
  validateStartBody,
  validatePlanBody,
} from '../src/validate.js';
import worker from '../src/index.js';

const NOW = new Date('2026-11-22T03:00:00Z'); // November 2026, UTC
const BRIEF = {
  destination: 'Vietnam',
  origin: 'Brisbane',
  travellers: 4,
  nights: 12,
  month: 7,
  year: 2027,
  budgetPerPersonAud: 3200,
  goal: 'best_value',
  pace: 'balanced',
  interests: 'food, hiking, history',
  notes: '',
};

const brief = (changes = {}) => ({ ...structuredClone(BRIEF), ...changes });
const s = (n) => 'x'.repeat(n);

function expectOk(changes) {
  const r = validateBrief(brief(changes), NOW);
  assert.equal(r.ok, true, `expected ok for ${JSON.stringify(changes)}: ${JSON.stringify(r.fields)}`);
  return r.value;
}

function expectBad(changes, name, problem) {
  const r = validateBrief(brief(changes), NOW);
  assert.equal(r.ok, false, `expected a failure for ${JSON.stringify(changes)}`);
  assert.deepEqual(r.fields, [{ name, problem }]);
}

describe('cleanString', () => {
  test('"  Viet<b>nam  " cleans to "Vietbnam"', () => {
    assert.equal(cleanString('  Viet<b>nam  '), 'Vietbnam');
  });

  test('whitespace runs, tabs and newlines become one space', () => {
    assert.equal(cleanString('Hanoi\n\n\tand   Hue'), 'Hanoi and Hue');
  });

  test('control characters U+0000 to U+001F and U+007F are removed', () => {
    assert.equal(cleanString('Ha\u0000no\u0007i\u001F\u007F'), 'Hanoi');
  });

  test('removing < and > leaves no double or edge spaces', () => {
    assert.equal(cleanString('a < b'), 'a b');
    assert.equal(cleanString('< Hanoi >'), 'Hanoi');
  });

  test('non-ASCII text is kept', () => {
    assert.equal(cleanString(' Hội An '), 'Hội An');
  });
});

describe('validateBrief: the 4.4 example', () => {
  test('passes and comes back unchanged', () => {
    assert.deepEqual(validateBrief(brief(), NOW), { ok: true, value: BRIEF });
  });

  test('strings are returned cleaned', () => {
    assert.equal(expectOk({ destination: '  Viet<b>nam  ' }).destination, 'Vietbnam');
  });
});

describe('validateBrief: string fields', () => {
  const cases = [
    ['destination', 2, 60],
    ['origin', 2, 40],
    ['interests', 0, 200],
    ['notes', 0, 300],
  ];
  for (const [name, min, max] of cases) {
    test(`${name}: ${min} and ${max} characters pass`, () => {
      assert.equal(expectOk({ [name]: s(min) })[name], s(min));
      assert.equal(expectOk({ [name]: s(max) })[name], s(max));
    });
    if (min > 0) {
      test(`${name}: ${min - 1} characters fails`, () => expectBad({ [name]: s(min - 1) }, name, 'too_short'));
    }
    test(`${name}: ${max + 1} characters fails`, () => expectBad({ [name]: s(max + 1) }, name, 'too_long'));
    test(`${name}: a number or null is the wrong type`, () => {
      expectBad({ [name]: 42 }, name, 'wrong_type');
      expectBad({ [name]: null }, name, 'wrong_type');
    });
  }

  test('lengths are measured after cleaning', () => {
    expectBad({ destination: '  a  ' }, 'destination', 'too_short');
    expectBad({ destination: '<<a>>' }, 'destination', 'too_short');
    assert.equal(expectOk({ destination: `  ${s(60)}  ` }).destination, s(60));
  });

  test('lengths count characters, not UTF-16 units', () => {
    assert.equal(expectOk({ destination: '🌏'.repeat(60) }).destination.length, 120);
  });
});

describe('validateBrief: integer fields', () => {
  const cases = [
    ['travellers', 1, 8],
    ['nights', 2, 21],
    ['month', 0, 12],
    ['year', 2026, 2028],
  ];
  for (const [name, min, max] of cases) {
    test(`${name}: ${min} and ${max} pass`, () => {
      // December 2026 is the only month left this year, so pair the year with it.
      const extra = name === 'year' ? { month: 12 } : name === 'month' ? { year: 2027 } : {};
      expectOk({ ...extra, [name]: min });
      expectOk({ ...extra, [name]: max });
    });
    test(`${name}: ${min - 1} and ${max + 1} fail`, () => {
      expectBad({ [name]: min - 1 }, name, 'out_of_range');
      expectBad({ [name]: max + 1 }, name, 'out_of_range');
    });
    test(`${name}: a numeric string, a fraction or a boolean is the wrong type`, () => {
      expectBad({ [name]: String(min + 1) }, name, 'wrong_type');
      expectBad({ [name]: min + 0.5 }, name, 'wrong_type');
      expectBad({ [name]: true }, name, 'wrong_type');
    });
  }

  test('a numeric string such as "4" for travellers fails', () => {
    expectBad({ travellers: '4' }, 'travellers', 'wrong_type');
  });
});

describe('validateBrief: the travel month', () => {
  test('a travel month in the past fails', () => {
    expectBad({ month: 10, year: 2026 }, 'month', 'in_the_past');
    expectBad({ month: 1, year: 2026 }, 'month', 'in_the_past');
  });

  test('the current month and later months pass', () => {
    expectOk({ month: 11, year: 2026 });
    expectOk({ month: 12, year: 2026 });
    expectOk({ month: 1, year: 2027 });
  });

  test('a flexible month (0) passes in the current year', () => {
    expectOk({ month: 0, year: 2026 });
  });

  test('a bad year gives one entry, not a past-month entry as well', () => {
    expectBad({ month: 1, year: 2025 }, 'year', 'out_of_range');
  });

  test('the year range follows now', () => {
    const r = validateBrief(brief({ year: 2029 }), new Date('2027-01-01T00:00:00Z'));
    assert.equal(r.ok, true);
  });
});

describe('validateBrief: budget', () => {
  test('0 (not sure), 300 and 30,000 pass', () => {
    for (const v of [0, 300, 30000]) expectOk({ budgetPerPersonAud: v });
  });

  test('1, 299, 30,001 and -1 fail', () => {
    for (const v of [1, 299, 30001, -1]) expectBad({ budgetPerPersonAud: v }, 'budgetPerPersonAud', 'out_of_range');
  });

  test('a numeric string or a fraction is the wrong type', () => {
    expectBad({ budgetPerPersonAud: '3200' }, 'budgetPerPersonAud', 'wrong_type');
    expectBad({ budgetPerPersonAud: 3200.5 }, 'budgetPerPersonAud', 'wrong_type');
  });
});

describe('validateBrief: enums', () => {
  test('every goal and pace passes', () => {
    for (const goal of ['cheapest', 'best_value', 'best_location', 'most_comfortable']) expectOk({ goal });
    for (const pace of ['relaxed', 'balanced', 'packed']) expectOk({ pace });
  });

  test('an unknown value is not allowed; a non-string is the wrong type', () => {
    expectBad({ goal: 'fastest' }, 'goal', 'not_allowed');
    expectBad({ goal: 'Best_Value' }, 'goal', 'not_allowed');
    expectBad({ pace: 'frantic' }, 'pace', 'not_allowed');
    expectBad({ goal: 1 }, 'goal', 'wrong_type');
    expectBad({ pace: ['relaxed'] }, 'pace', 'wrong_type');
  });
});

describe('validateBrief: shape', () => {
  test('all eleven fields are required, including empty interests and notes', () => {
    for (const name of Object.keys(BRIEF)) {
      const raw = brief();
      delete raw[name];
      assert.deepEqual(validateBrief(raw, NOW), { ok: false, fields: [{ name, problem: 'required' }] });
    }
  });

  test('an unknown brief field is rejected', () => {
    expectBad({ budget: 100 }, 'brief.budget', 'unknown_field');
  });

  test('an invalid brief gets one fields entry per bad field', () => {
    const r = validateBrief(brief({ destination: 'x', travellers: '4', nights: 30, goal: 'fast' }), NOW);
    assert.equal(r.ok, false);
    assert.deepEqual(r.fields.map((f) => f.name).sort(), ['destination', 'goal', 'nights', 'travellers']);
  });

  test('a missing or non-object brief fails', () => {
    assert.deepEqual(validateBrief(undefined, NOW).fields, [{ name: 'brief', problem: 'required' }]);
    for (const v of [null, 'Vietnam', [], 5]) {
      assert.deepEqual(validateBrief(v, NOW).fields, [{ name: 'brief', problem: 'wrong_type' }]);
    }
  });
});

describe('validateStartBody', () => {
  const body = (changes = {}) => ({ brief: brief(), turnstileToken: 'XXXX.DUMMY.TOKEN.XXXX', ...changes });

  test('a turnstileToken of 1 and 2,048 characters passes', () => {
    assert.equal(validateStartBody(body({ turnstileToken: 'x' }), NOW).ok, true);
    assert.equal(validateStartBody(body({ turnstileToken: s(2048) }), NOW).ok, true);
  });

  test('an empty, over-long, missing or non-string turnstileToken fails', () => {
    const problem = (token) => validateStartBody(body({ turnstileToken: token }), NOW).fields;
    assert.deepEqual(problem(''), [{ name: 'turnstileToken', problem: 'too_short' }]);
    assert.deepEqual(problem(s(2049)), [{ name: 'turnstileToken', problem: 'too_long' }]);
    assert.deepEqual(problem(undefined), [{ name: 'turnstileToken', problem: 'required' }]);
    assert.deepEqual(problem(123), [{ name: 'turnstileToken', problem: 'wrong_type' }]);
  });

  test('an unknown top-level field is rejected', () => {
    assert.deepEqual(validateStartBody(body({ extra: 1 }), NOW).fields, [{ name: 'extra', problem: 'unknown_field' }]);
  });

  test('brief and token problems are reported together', () => {
    const r = validateStartBody({ brief: brief({ nights: 1 }) }, NOW);
    assert.deepEqual(r.fields, [{ name: 'nights', problem: 'out_of_range' }, { name: 'turnstileToken', problem: 'required' }]);
  });
});

describe('validateAnswers', () => {
  const QUESTIONS = [
    { id: 'q1', options: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] },
    { id: 'q2', options: [{ id: 'a' }, { id: 'b' }] },
  ];
  const good = () => [{ questionId: 'q1', optionId: 'c' }, { questionId: 'q2', optionId: 'a' }];

  test('one valid answer per question passes, returned in question order', () => {
    const r = validateAnswers(good().reverse(), QUESTIONS);
    assert.deepEqual(r, { ok: true, value: good() });
  });

  test('a missing answer fails', () => {
    assert.deepEqual(validateAnswers(good().slice(0, 1), QUESTIONS).fields, [{ name: 'answers', problem: 'wrong_count' }]);
    assert.deepEqual(validateAnswers([], QUESTIONS).fields, [{ name: 'answers', problem: 'wrong_count' }]);
  });

  test('a second answer to the same question fails', () => {
    const r = validateAnswers([...good(), { questionId: 'q1', optionId: 'a' }], QUESTIONS);
    assert.deepEqual(r.fields, [{ name: 'answers[2]', problem: 'duplicate' }]);
  });

  test('ids that are not in the token fail', () => {
    const unknownQ = good();
    unknownQ[1].questionId = 'q9';
    assert.deepEqual(validateAnswers(unknownQ, QUESTIONS).fields, [{ name: 'answers[1]', problem: 'unknown_question' }]);
    const unknownO = good();
    unknownO[1].optionId = 'c';
    assert.deepEqual(validateAnswers(unknownO, QUESTIONS).fields, [{ name: 'answers[1]', problem: 'unknown_option' }]);
  });

  test('there is no free-text answer: wrong types and extra keys fail', () => {
    const typed = good();
    typed[0].optionId = 1;
    assert.deepEqual(validateAnswers(typed, QUESTIONS).fields, [{ name: 'answers[0]', problem: 'wrong_type' }]);
    const extra = good();
    extra[0].text = 'Something else';
    assert.deepEqual(validateAnswers(extra, QUESTIONS).fields, [{ name: 'answers[0].text', problem: 'unknown_field' }]);
    assert.deepEqual(validateAnswers(['q1:a', 'q2:b'], QUESTIONS).fields.map((f) => f.problem), ['wrong_type', 'wrong_type']);
  });

  test('a missing or non-array answers value fails', () => {
    assert.deepEqual(validateAnswers(undefined, QUESTIONS).fields, [{ name: 'answers', problem: 'required' }]);
    assert.deepEqual(validateAnswers({ q1: 'a' }, QUESTIONS).fields, [{ name: 'answers', problem: 'wrong_type' }]);
  });
});

describe('validatePlanBody', () => {
  test('a session string and an answers array pass', () => {
    assert.equal(validatePlanBody({ session: 'dev', answers: [] }).ok, true);
  });

  test('a missing or empty session, non-array answers and unknown fields fail', () => {
    assert.deepEqual(validatePlanBody({ answers: [] }).fields, [{ name: 'session', problem: 'required' }]);
    assert.deepEqual(validatePlanBody({ session: '', answers: [] }).fields, [{ name: 'session', problem: 'wrong_type' }]);
    assert.deepEqual(validatePlanBody({ session: 'dev', answers: 'a' }).fields, [{ name: 'answers', problem: 'wrong_type' }]);
    assert.deepEqual(validatePlanBody({ session: 'dev', answers: [], plan: {} }).fields, [{ name: 'plan', problem: 'unknown_field' }]);
  });
});

describe('validateRevision', () => {
  const body = (changes = {}) => ({ session: 'tok', plan: { title: 'Trip' }, request: 'Make it cheaper', ...changes });

  test('a request of 3 and 300 characters passes, cleaned', () => {
    assert.equal(validateRevision(body({ request: 'abc' })).value.request, 'abc');
    assert.equal(validateRevision(body({ request: s(300) })).value.request, s(300));
    assert.equal(validateRevision(body({ request: '  Drop <Ha Long>  ' })).value.request, 'Drop Ha Long');
  });

  test('a request of 2 or 301 characters after cleaning fails', () => {
    assert.deepEqual(validateRevision(body({ request: 'ab' })).fields, [{ name: 'request', problem: 'too_short' }]);
    assert.deepEqual(validateRevision(body({ request: '  ab  ' })).fields, [{ name: 'request', problem: 'too_short' }]);
    assert.deepEqual(validateRevision(body({ request: s(301) })).fields, [{ name: 'request', problem: 'too_long' }]);
  });

  test('wrong types, missing fields and unknown fields fail', () => {
    assert.deepEqual(validateRevision(body({ request: 12 })).fields, [{ name: 'request', problem: 'wrong_type' }]);
    assert.deepEqual(validateRevision(body({ plan: 'a plan' })).fields, [{ name: 'plan', problem: 'wrong_type' }]);
    assert.deepEqual(validateRevision(body({ plan: [] })).fields, [{ name: 'plan', problem: 'wrong_type' }]);
    const missing = body();
    delete missing.session;
    assert.deepEqual(validateRevision(missing).fields, [{ name: 'session', problem: 'required' }]);
    assert.deepEqual(validateRevision(body({ extra: true })).fields, [{ name: 'extra', problem: 'unknown_field' }]);
    assert.deepEqual(validateRevision(null).fields, [{ name: 'body', problem: 'wrong_type' }]);
  });

  test('the plan object is passed through untouched', () => {
    const plan = { title: 'Trip', budget_items: [{ units: 1 }] };
    assert.equal(validateRevision(body({ plan })).value.plan, plan);
  });
});

describe('router: body checks', () => {
  const ENV = { ALLOWED_ORIGINS: 'http://localhost:8788', MODEL: 'claude-haiku-5-5', MOCK_ANTHROPIC: '1' };
  const post = (path, body, headers = {}) => worker.fetch(new Request(`http://localhost:8787${path}`, {
    method: 'POST',
    headers: { Origin: 'http://localhost:8788', 'Content-Type': 'application/json', ...headers },
    body,
  }), ENV, { waitUntil() {} });
  const startBody = (changes = {}) => JSON.stringify({ brief: brief(changes), turnstileToken: 'XXXX.DUMMY.TOKEN.XXXX' });
  const errorOf = async (res) => (await res.json()).error;

  test('a 9 KB body to /start returns 400 invalid_input', async () => {
    const res = await post('/api/trail/start', JSON.stringify({ brief: brief({ notes: s(9 * 1024) }), turnstileToken: 'x' }));
    assert.equal(res.status, 400);
    const error = await errorOf(res);
    assert.equal(error.code, 'invalid_input');
    assert.deepEqual(error.fields, [{ name: 'body', problem: 'too_large' }]);
  });

  test('size is measured in bytes: 3,000 three-byte characters is over 8 KB', async () => {
    const res = await post('/api/trail/start', JSON.stringify({ brief: brief({ notes: '中'.repeat(3000) }) }));
    assert.deepEqual((await errorOf(res)).fields, [{ name: 'body', problem: 'too_large' }]);
  });

  test('a missing or wrong Content-Type returns 400', async () => {
    const res = await post('/api/trail/start', startBody(), { 'Content-Type': 'text/plain' });
    assert.equal(res.status, 400);
    assert.deepEqual((await errorOf(res)).fields, [{ name: 'body', problem: 'content_type' }]);
  });

  test('Content-Type with a charset parameter is accepted', async () => {
    const res = await post('/api/trail/start', startBody(), { 'Content-Type': 'application/json; charset=utf-8' });
    assert.equal(res.status, 200);
  });

  test('invalid JSON and a non-object body return 400', async () => {
    assert.deepEqual((await errorOf(await post('/api/trail/start', '{"brief":'))).fields, [{ name: 'body', problem: 'invalid_json' }]);
    assert.deepEqual((await errorOf(await post('/api/trail/plan', '[1,2]'))).fields, [{ name: 'body', problem: 'not_an_object' }]);
  });

  test('an invalid brief returns 400 with one fields entry per bad field', async () => {
    const res = await post('/api/trail/start', startBody({ travellers: '4', nights: 40, month: 13 }));
    assert.equal(res.status, 400);
    const error = await errorOf(res);
    assert.equal(error.code, 'invalid_input');
    assert.deepEqual(error.fields.map((f) => f.name).sort(), ['month', 'nights', 'travellers']);
  });

  test('a valid /start and /plan still return 200', async () => {
    assert.equal((await post('/api/trail/start', startBody())).status, 200);
    assert.equal((await post('/api/trail/plan', JSON.stringify({ session: 'dev', answers: [] }))).status, 200);
  });
});
