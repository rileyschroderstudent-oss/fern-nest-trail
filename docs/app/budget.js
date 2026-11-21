// RILEY BUILDS THIS (SPEC.md Task 4). Until then both functions throw, and the Plan
// screen shows "Totals unavailable" with unit costs only.
//
// computeBudget(items, travellers, contingencyPct)
//   returns { byCategory: { <category>: { low, high, mid } }, subtotal, contingency,
//             total, perPerson }, each { low, high, mid }, all in AUD, unrounded.
//
// fitVerdict(perPersonMid, perPersonHigh, budgetPerPerson)
//   returns { verdict, gapAud, fitsAtHighEnd }, where verdict is
//   'fits', 'tight', 'over' or 'no_budget'.
//
// The rules and the worked example are in SPEC.md Task 4. Tests: budget.test.mjs.

export function computeBudget(items, travellers, contingencyPct) {
  throw new Error('budget.js not implemented');
}

export function fitVerdict(perPersonMid, perPersonHigh, budgetPerPerson) {
  throw new Error('budget.js not implemented');
}
