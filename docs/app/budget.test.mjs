// Tests for budget.js: every case listed in SPEC.md Task 4.
// Run with: node --test docs/app/budget.test.mjs
// These fail until computeBudget and fitVerdict are written.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { computeBudget, fitVerdict } from './budget.js';

// Money is never rounded (rule 6), so compare with a tiny tolerance that allows
// for floating-point noise such as 1196.0000000000002 but nothing larger.
function near(actual, expected, label = '') {
  assert.equal(typeof actual, 'number', `${label} should be a number`);
  assert.ok(Math.abs(actual - expected) < 1e-6, `${label}: expected ${expected}, got ${actual}`);
}

function nearTriple(actual, [low, high, mid], label) {
  assert.ok(actual && typeof actual === 'object', `${label} should be an object`);
  near(actual.low, low, `${label}.low`);
  near(actual.high, high, `${label}.high`);
  near(actual.mid, mid, `${label}.mid`);
}

const item = (category, basis, units, low, high) => ({
  category,
  label: `${category} item`,
  basis,
  units,
  unit_low_aud: low,
  unit_high_aud: high,
  note: '',
  kind: 'estimate',
});

// The worked example: 4 travellers, 10% contingency.
const WORKED = [
  item('flights', 'per_person', 1, 900, 1300),
  item('accommodation', 'per_group', 12, 180, 260),
  item('food', 'per_person', 13, 40, 70),
];

describe('computeBudget', () => {
  test('case 1: the worked example, every number', () => {
    const r = computeBudget(WORKED, 4, 10);
    assert.deepEqual(Object.keys(r.byCategory).sort(), ['accommodation', 'flights', 'food']);
    nearTriple(r.byCategory.flights, [3600, 5200, 4400], 'byCategory.flights');
    nearTriple(r.byCategory.accommodation, [2160, 3120, 2640], 'byCategory.accommodation');
    nearTriple(r.byCategory.food, [2080, 3640, 2860], 'byCategory.food');
    nearTriple(r.subtotal, [7840, 11960, 9900], 'subtotal');
    nearTriple(r.contingency, [784, 1196, 990], 'contingency');
    nearTriple(r.total, [8624, 13156, 10890], 'total');
    nearTriple(r.perPerson, [2156, 3289, 2722.5], 'perPerson');
  });

  test('case 2: an empty item list gives zeros everywhere and an empty byCategory', () => {
    const r = computeBudget([], 4, 10);
    assert.deepEqual(r.byCategory, {});
    for (const key of ['subtotal', 'contingency', 'total', 'perPerson']) {
      nearTriple(r[key], [0, 0, 0], key);
    }
  });

  test('case 3: a per_group line ignores travellers', () => {
    const r = computeBudget([item('local_transport', 'per_group', 3, 100, 200)], 5, 10);
    nearTriple(r.byCategory.local_transport, [300, 600, 450], 'byCategory.local_transport');
    nearTriple(r.subtotal, [300, 600, 450], 'subtotal');
  });

  test('case 4: a contingency of 0 makes total equal subtotal', () => {
    const r = computeBudget(WORKED, 4, 0);
    nearTriple(r.contingency, [0, 0, 0], 'contingency');
    nearTriple(r.total, [r.subtotal.low, r.subtotal.high, r.subtotal.mid], 'total');
    nearTriple(r.total, [7840, 11960, 9900], 'total');
  });

  test('case 5: two accommodation items land in one byCategory entry', () => {
    const items = [
      item('accommodation', 'per_group', 3, 100, 150),
      item('accommodation', 'per_person', 2, 50, 80),
    ];
    const r = computeBudget(items, 2, 10);
    assert.deepEqual(Object.keys(r.byCategory), ['accommodation']);
    // 300-450 for the group line, plus 200-320 for the per-person line.
    nearTriple(r.byCategory.accommodation, [500, 770, 635], 'byCategory.accommodation');
  });

  describe('case 6: each bad input throws a TypeError', () => {
    const good = () => structuredClone(WORKED);
    const cases = [
      ['travellers of 0', () => computeBudget(good(), 0, 10)],
      ['travellers of 2.5', () => computeBudget(good(), 2.5, 10)],
      ['travellers of the string "4"', () => computeBudget(good(), '4', 10)],
      ['contingency of -1', () => computeBudget(good(), 4, -1)],
      ['contingency of 51', () => computeBudget(good(), 4, 51)],
      ['low above high', () => computeBudget([item('food', 'per_person', 1, 80, 40)], 4, 10)],
      ['a negative cost', () => computeBudget([item('food', 'per_person', 1, -10, 40)], 4, 10)],
      ['units of 0', () => computeBudget([item('food', 'per_person', 0, 40, 70)], 4, 10)],
      ['a basis of "each"', () => computeBudget([item('food', 'each', 1, 40, 70)], 4, 10)],
    ];
    for (const [name, fn] of cases) {
      test(name, () => assert.throws(fn, TypeError));
    }
  });

  test('case 8: the input array and its objects are unchanged after the call', () => {
    const items = structuredClone(WORKED);
    const before = structuredClone(items);
    computeBudget(items, 4, 10);
    assert.deepEqual(items, before);
  });
});

describe('fitVerdict', () => {
  // Per person from the worked example: mid 2,722.50, high 3,289.
  const MID = 2722.5;
  const HIGH = 3289;
  const rows = [
    [3000, 'fits', -277.5, false],
    [2600, 'tight', 122.5, false],
    [2400, 'over', 322.5, false],
    [3300, 'fits', -577.5, true],
    [0, 'no_budget', 0, false],
  ];

  for (const [budget, verdict, gap, fitsAtHighEnd] of rows) {
    test(`case 7: a budget of ${budget} gives ${verdict}`, () => {
      const r = fitVerdict(MID, HIGH, budget);
      assert.equal(r.verdict, verdict);
      near(r.gapAud, gap, 'gapAud');
      assert.equal(r.fitsAtHighEnd, fitsAtHighEnd);
    });
  }

  test('case 7 boundary: mid exactly equal to the budget is fits', () => {
    const r = fitVerdict(1000, 1200, 1000);
    assert.equal(r.verdict, 'fits');
    near(r.gapAud, 0, 'gapAud');
  });

  test('case 7 boundary: mid of 1,100 against a budget of 1,000 is tight', () => {
    const r = fitVerdict(1100, 1200, 1000);
    assert.equal(r.verdict, 'tight');
    near(r.gapAud, 100, 'gapAud');
  });
});
