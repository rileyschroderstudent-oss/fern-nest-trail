// docs/app/budget.js — SPEC.md Task 4
// Pure functions: no DOM, no network, no dependencies.
// AI-written exemplar, committed to ship v1. Riley is reworking it by hand.

const BASES = new Set(['per_person', 'per_group']);

/** Build a {low, high, mid} triple. */
const range = (low, high) => ({ low, high, mid: (low + high) / 2 });

/** Cost of one line item as {low, high}, after validating it. */
function lineCost(item, travellers) {
  const { basis, units, unit_low_aud: lo, unit_high_aud: hi } = item;

  if (!BASES.has(basis)) throw new TypeError(`Unknown basis: ${basis}`);
  if (typeof units !== 'number' || !(units >= 1)) {
    throw new TypeError(`units must be a number >= 1, got ${units}`);
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo < 0 || hi < 0) {
    throw new TypeError('Costs must be non-negative numbers');
  }
  if (lo > hi) throw new TypeError(`unit_low_aud (${lo}) > unit_high_aud (${hi})`);

  const multiplier = units * (basis === 'per_person' ? travellers : 1);
  return { low: lo * multiplier, high: hi * multiplier };
}

export function computeBudget(items, travellers, contingencyPct) {
  if (!Number.isInteger(travellers) || travellers < 1) {
    throw new TypeError(`travellers must be a positive integer, got ${travellers}`);
  }
  if (typeof contingencyPct !== 'number' || !(contingencyPct >= 0 && contingencyPct <= 50)) {
    throw new TypeError(`contingencyPct must be a number from 0 to 50, got ${contingencyPct}`);
  }
  if (!Array.isArray(items)) throw new TypeError('items must be an array');

  const sums = {};
  let low = 0;
  let high = 0;

  for (const item of items) {
    const line = lineCost(item, travellers);
    const cat = (sums[item.category] ??= { low: 0, high: 0 });
    cat.low += line.low;
    cat.high += line.high;
    low += line.low;
    high += line.high;
  }

  const byCategory = {};
  for (const [name, s] of Object.entries(sums)) byCategory[name] = range(s.low, s.high);

  const subtotal = range(low, high);
  const contingency = range(
    (low * contingencyPct) / 100,
    (high * contingencyPct) / 100,
  );
  const total = range(low + contingency.low, high + contingency.high);
  const perPerson = range(total.low / travellers, total.high / travellers);

  return { byCategory, subtotal, contingency, total, perPerson };
}

export function fitVerdict(perPersonMid, perPersonHigh, budgetPerPerson) {
  if (budgetPerPerson === 0) {
    return { verdict: 'no_budget', gapAud: 0, fitsAtHighEnd: false };
  }

  const gapAud = perPersonMid - budgetPerPerson;
  let verdict;
  if (gapAud <= 0) verdict = 'fits';
  // "Up to 10% over" as gap * 10 <= budget, avoiding budget * 1.1 float error.
  else if (gapAud * 10 <= budgetPerPerson) verdict = 'tight';
  else verdict = 'over';

  return { verdict, gapAud, fitsAtHighEnd: perPersonHigh <= budgetPerPerson };
}
