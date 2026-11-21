// Post-validation tests (SPEC.md 4.7 output tables). Each table row has one test,
// made by mutating a fixture. Run with `npm test`.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { shapeQuestions, shapePlan } from '../src/postvalidate.js';
import { callModel } from '../src/anthropic.js';
import { QUESTIONS_FIXTURE } from '../src/fixtures/questions.js';
import { PLAN_FIXTURE } from '../src/fixtures/plan.js';
import { DECLINED_QUESTIONS_FIXTURE, DECLINED_PLAN_FIXTURE } from '../src/fixtures/declined.js';

const BRIEF = { destination: 'Vietnam', travellers: 4, nights: 12, month: 7, year: 2027 };

const questions = () => structuredClone(QUESTIONS_FIXTURE);
const plan = () => structuredClone(PLAN_FIXTURE);
const long = (n) => 'x'.repeat(n);

// Message in the SPEC.md 4.9 format, enough for the mock to read the destination.
const message = (destination) =>
  `Today is 2026-11-21 (UTC).\nSTAGE: plan\n<trip_brief>\n${JSON.stringify({ destination })}\n</trip_brief>\nWrite the trip plan.`;
const MOCK_ENV = { MOCK_ANTHROPIC: '1' };

describe('shapeQuestions: fixture', () => {
  test('the fixture passes and gets ids q1... and a...', () => {
    const r = shapeQuestions(questions());
    assert.equal(r.ok, true);
    assert.deepEqual(r.warnings, []);
    assert.deepEqual(r.value.questions.map((q) => q.id), ['q1', 'q2', 'q3', 'q4']);
    assert.deepEqual(r.value.questions[0].options.map((o) => o.id), ['a', 'b', 'c']);
    assert.equal(r.value.questions[0].options[1].label, QUESTIONS_FIXTURE.questions[0].options[1]);
    assert.deepEqual(r.value.assumptions, QUESTIONS_FIXTURE.assumptions);
  });

  test('a declined status returns the declined value', () => {
    const r = shapeQuestions(structuredClone(DECLINED_QUESTIONS_FIXTURE));
    assert.deepEqual(r, { ok: true, value: { type: 'declined', reason: 'not_travel' }, warnings: [] });
  });

  test('a decline with reason none is reported as other', () => {
    const raw = { ...structuredClone(DECLINED_QUESTIONS_FIXTURE), decline_reason: 'none' };
    assert.equal(shapeQuestions(raw).value.reason, 'other');
  });
});

describe('shapeQuestions: 4.7 output table', () => {
  test('row 1: fewer than 2 questions, or a question with fewer than 2 options, is bad output', () => {
    const few = questions();
    few.questions = few.questions.slice(0, 1);
    assert.deepEqual(shapeQuestions(few), { ok: false, outcome: 'invalid_plan' });

    const thin = questions();
    thin.questions[1].options = ['only one'];
    assert.deepEqual(shapeQuestions(thin), { ok: false, outcome: 'invalid_plan' });
  });

  test('row 2: more than 4 questions, or more than 4 options, drops the extras', () => {
    const raw = questions();
    raw.questions.push({ text: 'Fifth?', why: 'Extra.', options: ['a', 'b'] });
    raw.questions[0].options = ['one', 'two', 'three', 'four', 'five'];
    const r = shapeQuestions(raw);
    assert.equal(r.ok, true);
    assert.equal(r.value.questions.length, 4);
    assert.deepEqual(r.value.questions[0].options.map((o) => o.id), ['a', 'b', 'c', 'd']);
    assert.equal(r.value.questions[0].options[3].label, 'four');
  });

  test('row 3: text and why over 200, option over 120, assumption over 200 are cut', () => {
    const raw = questions();
    raw.questions[0].text = long(250);
    raw.questions[0].why = long(201);
    raw.questions[0].options[0] = long(130);
    raw.assumptions[0] = long(300);
    const r = shapeQuestions(raw);
    assert.equal(r.ok, true);
    assert.equal(r.value.questions[0].text.length, 200);
    assert.equal(r.value.questions[0].why.length, 200);
    assert.equal(r.value.questions[0].options[0].label.length, 120);
    assert.equal(r.value.assumptions[0].length, 200);
    // Strings at the limit are left alone.
    assert.equal(r.value.questions[1].text, QUESTIONS_FIXTURE.questions[1].text);
  });

  test('row 4: more than 4 assumptions drops the extras', () => {
    const raw = questions();
    raw.assumptions = ['one', 'two', 'three', 'four', 'five', 'six'];
    const r = shapeQuestions(raw);
    assert.deepEqual(r.value.assumptions, ['one', 'two', 'three', 'four']);
  });

  test('row 5: any string matching the banned-phrase pattern is bad output', () => {
    const cases = [
      (q) => { q.assumptions[0] = 'Using live fares for July'; },
      (q) => { q.questions[2].why = 'I checked the train times.'; },
      (q) => { q.questions[0].options[1] = 'Real-time data says this is cheaper'; },
      (q) => { q.questions[3].text = 'These rates are guaranteed, is that fine?'; },
    ];
    for (const mutate of cases) {
      const raw = questions();
      mutate(raw);
      assert.deepEqual(shapeQuestions(raw), { ok: false, outcome: 'banned_phrase' });
    }
  });
});

describe('shapePlan: fixture', () => {
  test('the plan fixture passes with no warnings and nothing cut', () => {
    const r = shapePlan(plan(), BRIEF);
    assert.equal(r.ok, true);
    assert.deepEqual(r.warnings, []);
    const expected = plan();
    delete expected.status;
    delete expected.decline_reason;
    for (const item of expected.budget_items) item.kind = 'estimate';
    assert.deepEqual(r.value, expected);
  });

  test('the fixture matches Task 2: 4 stops summing to 12 nights, 13 days, at least 9 items', () => {
    assert.equal(PLAN_FIXTURE.route.length, 4);
    assert.equal(PLAN_FIXTURE.route.reduce((s, r) => s + r.nights, 0), 12);
    assert.equal(PLAN_FIXTURE.days.length, 13);
    assert.ok(PLAN_FIXTURE.budget_items.length >= 9);
  });

  test('the result drops status and decline_reason and marks every item as an estimate', () => {
    const r = shapePlan(plan(), BRIEF);
    assert.equal('status' in r.value, false);
    assert.equal('decline_reason' in r.value, false);
    assert.ok(r.value.budget_items.every((it) => it.kind === 'estimate'));
  });

  test('shaping does not change its input', () => {
    const raw = plan();
    raw.budget_items[0].unit_low_aud = 2000; // forces a swap
    const before = structuredClone(raw);
    shapePlan(raw, BRIEF);
    assert.deepEqual(raw, before);
  });

  test('a declined status returns the declined value', () => {
    const r = shapePlan(structuredClone(DECLINED_PLAN_FIXTURE), BRIEF);
    assert.deepEqual(r, { ok: true, value: { type: 'declined', reason: 'not_travel' }, warnings: [] });
  });
});

describe('shapePlan: 4.7 output table', () => {
  test('row 1: route empty or over 6, days empty or over 22, budget items under 4 or over 25', () => {
    const mutations = [
      (p) => { p.route = []; },
      (p) => { p.route = Array.from({ length: 7 }, () => ({ ...p.route[0], nights: 1 })); },
      (p) => { p.days = []; },
      (p) => { p.days = Array.from({ length: 23 }, (_, i) => ({ day: i + 1, base: 'Hanoi', plan: 'Walk.' })); },
      (p) => { p.budget_items = p.budget_items.slice(0, 3); },
      (p) => { p.budget_items = Array.from({ length: 26 }, () => ({ ...p.budget_items[0] })); },
    ];
    for (const mutate of mutations) {
      const raw = plan();
      mutate(raw);
      assert.deepEqual(shapePlan(raw, BRIEF), { ok: false, outcome: 'invalid_plan' });
    }
    // The boundaries pass.
    const edge = plan();
    edge.budget_items = edge.budget_items.slice(0, 4);
    assert.equal(shapePlan(edge, BRIEF).ok, true);
  });

  test('row 2: a negative number, units out of 1-100, a unit cost over 50,000 or route nights under 1', () => {
    const mutations = [
      (p) => { p.levers[0].saves_per_person_aud = -5; },
      (p) => { p.days[0].day = -1; },
      (p) => { p.budget_items[2].unit_low_aud = -10; },
      (p) => { p.budget_items[0].units = 0; },
      (p) => { p.budget_items[0].units = 101; },
      (p) => { p.budget_items[0].unit_high_aud = 50001; },
      (p) => { p.route[0].nights = 0; },
    ];
    for (const mutate of mutations) {
      const raw = plan();
      mutate(raw);
      assert.deepEqual(shapePlan(raw, BRIEF), { ok: false, outcome: 'invalid_plan' });
    }
    const edge = plan();
    edge.budget_items[0].units = 100;
    edge.budget_items[0].unit_high_aud = 50000;
    assert.equal(shapePlan(edge, BRIEF).ok, true);
  });

  test('row 3: unit_low_aud greater than unit_high_aud is swapped', () => {
    const raw = plan();
    raw.budget_items[0].unit_low_aud = 1800;
    raw.budget_items[0].unit_high_aud = 1100;
    const r = shapePlan(raw, BRIEF);
    assert.equal(r.ok, true);
    assert.equal(r.value.budget_items[0].unit_low_aud, 1100);
    assert.equal(r.value.budget_items[0].unit_high_aud, 1800);
  });

  test('row 4: route nights that differ from the brief add route_nights_mismatch', () => {
    const raw = plan();
    raw.route[0].nights = 4;
    const r = shapePlan(raw, BRIEF);
    assert.equal(r.ok, true);
    assert.deepEqual(r.warnings, ['route_nights_mismatch']);
  });

  test('row 5: days length other than nights plus 1 adds days_count_mismatch', () => {
    const raw = plan();
    raw.days.pop();
    const r = shapePlan(raw, BRIEF);
    assert.equal(r.ok, true);
    assert.deepEqual(r.warnings, ['days_count_mismatch']);
  });

  test('row 6: no flights, accommodation or food item adds a missing_ warning for each', () => {
    for (const cat of ['flights', 'accommodation', 'food']) {
      const raw = plan();
      raw.budget_items = raw.budget_items.filter((it) => it.category !== cat);
      const r = shapePlan(raw, BRIEF);
      assert.equal(r.ok, true);
      assert.deepEqual(r.warnings, [`missing_${cat}`]);
    }
  });

  test('row 7: more than 5 levers, 8 verify items or 6 assumptions drops the extras', () => {
    const raw = plan();
    raw.levers = Array.from({ length: 7 }, (_, i) => ({ change: `Lever ${i}`, saves_per_person_aud: i }));
    raw.verify_before_booking = Array.from({ length: 10 }, (_, i) => `Check ${i}`);
    raw.assumptions = Array.from({ length: 9 }, (_, i) => `Assume ${i}`);
    const r = shapePlan(raw, BRIEF);
    assert.equal(r.ok, true);
    assert.equal(r.value.levers.length, 5);
    assert.equal(r.value.levers[4].change, 'Lever 4');
    assert.equal(r.value.verify_before_booking.length, 8);
    assert.equal(r.value.assumptions.length, 6);
  });

  test('row 8: strings over their limit are cut (title 80, day plan 300, note 160, honest_take 600, others 240)', () => {
    const raw = plan();
    raw.title = long(100);
    raw.days[0].plan = long(400);
    raw.budget_items[0].note = long(200);
    raw.honest_take = long(700);
    raw.season_note = long(300);
    raw.route[0].area_reason = long(300);
    raw.flights.routing = long(300);
    raw.levers[0].change = long(300);
    raw.verify_before_booking[0] = long(300);
    raw.assumptions[0] = long(300);
    raw.days[0].base = long(300);
    raw.budget_items[0].label = long(300);
    const r = shapePlan(raw, BRIEF);
    assert.equal(r.ok, true);
    const v = r.value;
    assert.equal(v.title.length, 80);
    assert.equal(v.days[0].plan.length, 300);
    assert.equal(v.budget_items[0].note.length, 160);
    assert.equal(v.honest_take.length, 600);
    for (const s of [
      v.season_note, v.route[0].area_reason, v.flights.routing, v.levers[0].change,
      v.verify_before_booking[0], v.assumptions[0], v.days[0].base, v.budget_items[0].label,
    ]) {
      assert.equal(s.length, 240);
    }
  });

  test('row 9: any string matching the banned-phrase pattern is bad output', () => {
    const mutations = [
      (p) => { p.honest_take = 'These are live prices for your dates.'; },
      (p) => { p.budget_items[0].note = 'Guaranteed fares on this route.'; },
      (p) => { p.flights.timing = 'I have looked up the cheapest week.'; },
      (p) => { p.days[3].plan = 'I found a great homestay.'; },
      (p) => { p.verify_before_booking[0] = 'The price is guaranteed until June'; },
    ];
    for (const mutate of mutations) {
      const raw = plan();
      mutate(raw);
      assert.deepEqual(shapePlan(raw, BRIEF), { ok: false, outcome: 'banned_phrase' });
    }
  });
});

describe('mock callModel triggers (SPEC.md 4.9)', () => {
  test('TEST-BANNED: the plan call returns a plan that shapePlan rejects as bad output', async () => {
    const r = await callModel(MOCK_ENV, 'plan', message('TEST-BANNED'));
    assert.equal(r.kind, 'ok');
    assert.match(r.json.honest_take, /live prices/);
    assert.deepEqual(shapePlan(r.json, BRIEF), { ok: false, outcome: 'banned_phrase' });
  });

  test('TEST-DECLINE returns declined output at both stages', async () => {
    for (const [stage, shape] of [['start', shapeQuestions], ['plan', (j) => shapePlan(j, BRIEF)]]) {
      const r = await callModel(MOCK_ENV, stage, message('TEST-DECLINE'));
      assert.equal(r.kind, 'ok');
      assert.deepEqual(shape(r.json).value, { type: 'declined', reason: 'not_travel' });
    }
  });

  test('TEST-REFUSAL, TEST-TRUNCATED and TEST-BUSY map to their kinds', async () => {
    assert.equal((await callModel(MOCK_ENV, 'plan', message('TEST-REFUSAL'))).kind, 'refusal');
    assert.equal((await callModel(MOCK_ENV, 'plan', message('TEST-TRUNCATED'))).kind, 'truncated');
    const busy = await callModel(MOCK_ENV, 'plan', message('TEST-BUSY'));
    assert.equal(busy.kind, 'upstream_busy');
    assert.deepEqual(busy.usage, { input_tokens: 0, output_tokens: 0 });
  });

  test('normal calls return the fixtures with the 4.9 mock usage', async () => {
    const start = await callModel(MOCK_ENV, 'start', message('Vietnam'));
    assert.deepEqual(start, { kind: 'ok', json: QUESTIONS_FIXTURE, usage: { input_tokens: 3050, output_tokens: 800 } });
    const planned = await callModel(MOCK_ENV, 'plan', message('Vietnam'));
    assert.deepEqual(planned, { kind: 'ok', json: PLAN_FIXTURE, usage: { input_tokens: 4150, output_tokens: 4500 } });
  });

  test('without MOCK_ANTHROPIC=1 no call is made yet', async () => {
    const r = await callModel({ MOCK_ANTHROPIC: '0' }, 'plan', message('Vietnam'));
    assert.equal(r.kind, 'internal_error');
  });
});
