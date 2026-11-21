// Checks on model output (SPEC.md 4.7, "Output: questions" and "Output: plan").
// Each function returns { ok: true, value, warnings } or { ok: false, outcome }.
// A decline is a valid result: { ok: true, value: { type: 'declined', reason }, warnings: [] }.
import { QUESTIONS_LIMITS as QL, PLAN_LIMITS as PL, REQUIRED_CATEGORIES } from './config.js';

export const BANNED_PHRASE = new RegExp(
  [
    String.raw`\b(live|real[- ]time)\s+(price|fare|rate|quote|data)s?\b`,
    String.raw`\bguaranteed\s+(price|fare|rate)s?\b`,
    String.raw`\b(price|fare|rate)s?\s+(is|are)\s+guaranteed\b`,
    String.raw`\bI\s+(have\s+)?(searched|checked|found|looked\s+up)\b`,
  ].join('|'),
  'i',
);

const DECLINE_REASONS = ['not_travel', 'unclear_destination', 'unsafe_or_abusive', 'other'];
const OPTION_IDS = ['a', 'b', 'c', 'd'];

const fail = (outcome) => ({ ok: false, outcome });

function declined(raw) {
  const reason = DECLINE_REASONS.includes(raw.decline_reason) ? raw.decline_reason : 'other';
  return { ok: true, value: { type: 'declined', reason }, warnings: [] };
}

// True if any string anywhere in the value matches the banned-phrase pattern.
// Runs on the raw output, before anything is cut or dropped.
function hasBannedPhrase(value) {
  if (typeof value === 'string') return BANNED_PHRASE.test(value);
  if (Array.isArray(value)) return value.some(hasBannedPhrase);
  if (value && typeof value === 'object') return Object.values(value).some(hasBannedPhrase);
  return false;
}

function hasNegativeNumber(value) {
  if (typeof value === 'number') return value < 0;
  if (Array.isArray(value)) return value.some(hasNegativeNumber);
  if (value && typeof value === 'object') return Object.values(value).some(hasNegativeNumber);
  return false;
}

// Cut by code point so a surrogate pair is never split.
function cut(s, max) {
  const chars = Array.from(s);
  return chars.length > max ? chars.slice(0, max).join('') : s;
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStringArray = (v) => Array.isArray(v) && v.every((s) => typeof s === 'string');

export function shapeQuestions(raw) {
  if (!isObject(raw)) return fail('invalid_plan');
  if (raw.status === 'declined') return declined(raw);
  if (raw.status !== 'ok') return fail('invalid_plan');
  if (!isStringArray(raw.assumptions) || !Array.isArray(raw.questions)) return fail('invalid_plan');
  if (hasBannedPhrase(raw)) return fail('banned_phrase');

  const kept = raw.questions.slice(0, QL.maxQuestions);
  if (kept.length < QL.minQuestions) return fail('invalid_plan');

  const questions = [];
  for (const [i, q] of kept.entries()) {
    if (!isObject(q) || typeof q.text !== 'string' || typeof q.why !== 'string' || !isStringArray(q.options)) {
      return fail('invalid_plan');
    }
    if (q.options.length < QL.minOptions) return fail('invalid_plan');
    questions.push({
      id: `q${i + 1}`,
      text: cut(q.text, QL.textChars),
      why: cut(q.why, QL.whyChars),
      options: q.options.slice(0, QL.maxOptions).map((label, j) => ({
        id: OPTION_IDS[j],
        label: cut(label, QL.optionChars),
      })),
    });
  }

  const assumptions = raw.assumptions.slice(0, QL.maxAssumptions).map((s) => cut(s, QL.assumptionChars));
  return { ok: true, value: { assumptions, questions }, warnings: [] };
}

const PLAN_ARRAYS = ['route', 'days', 'budget_items', 'levers', 'verify_before_booking', 'assumptions'];
const PLAN_STRINGS = ['title', 'season_note', 'honest_take'];

export function shapePlan(raw, brief) {
  if (!isObject(raw)) return fail('invalid_plan');
  if (raw.status === 'declined') return declined(raw);
  if (raw.status !== 'ok') return fail('invalid_plan');
  if (PLAN_ARRAYS.some((k) => !Array.isArray(raw[k]))) return fail('invalid_plan');
  if (PLAN_STRINGS.some((k) => typeof raw[k] !== 'string') || !isObject(raw.flights)) return fail('invalid_plan');
  if (hasBannedPhrase(raw)) return fail('banned_phrase');

  // Counts.
  if (raw.route.length < PL.minRouteStops || raw.route.length > PL.maxRouteStops) return fail('invalid_plan');
  if (raw.days.length < PL.minDays || raw.days.length > PL.maxDays) return fail('invalid_plan');
  if (raw.budget_items.length < PL.minBudgetItems || raw.budget_items.length > PL.maxBudgetItems) {
    return fail('invalid_plan');
  }

  // Numbers.
  if (hasNegativeNumber(raw)) return fail('invalid_plan');
  for (const stop of raw.route) {
    if (!isObject(stop) || !Number.isInteger(stop.nights) || stop.nights < PL.minRouteNights) return fail('invalid_plan');
  }
  for (const item of raw.budget_items) {
    if (!isObject(item)) return fail('invalid_plan');
    if (!Number.isInteger(item.units) || item.units < PL.minUnits || item.units > PL.maxUnits) return fail('invalid_plan');
    for (const k of ['unit_low_aud', 'unit_high_aud']) {
      if (!Number.isInteger(item[k]) || item[k] > PL.maxUnitCostAud) return fail('invalid_plan');
    }
  }

  const limit = (s, max = PL.otherChars) => cut(String(s), max);

  const route = raw.route.map((s) => ({
    place: limit(s.place),
    nights: s.nights,
    area_to_stay: limit(s.area_to_stay),
    area_reason: limit(s.area_reason),
    stay_type: limit(s.stay_type),
  }));

  const days = raw.days.map((d) => ({
    day: d.day,
    base: limit(d.base),
    plan: limit(d.plan, PL.dayPlanChars),
  }));

  const budget_items = raw.budget_items.map((it) => {
    const low = Math.min(it.unit_low_aud, it.unit_high_aud);
    const high = Math.max(it.unit_low_aud, it.unit_high_aud);
    return {
      category: limit(it.category),
      label: limit(it.label),
      basis: limit(it.basis),
      units: it.units,
      unit_low_aud: low,
      unit_high_aud: high,
      note: limit(it.note, PL.noteChars),
      kind: 'estimate',
    };
  });

  const warnings = [];
  const routeNights = route.reduce((sum, s) => sum + s.nights, 0);
  if (routeNights !== brief.nights) warnings.push('route_nights_mismatch');
  if (days.length !== brief.nights + 1) warnings.push('days_count_mismatch');
  for (const cat of REQUIRED_CATEGORIES) {
    if (!budget_items.some((it) => it.category === cat)) warnings.push(`missing_${cat}`);
  }

  const value = {
    title: limit(raw.title, PL.titleChars),
    route,
    season_note: limit(raw.season_note),
    flights: {
      routing: limit(raw.flights.routing),
      timing: limit(raw.flights.timing),
      peak_warning: limit(raw.flights.peak_warning),
    },
    days,
    budget_items,
    levers: raw.levers.slice(0, PL.maxLevers).map((l) => ({
      change: limit(l.change),
      saves_per_person_aud: l.saves_per_person_aud,
    })),
    honest_take: limit(raw.honest_take, PL.honestTakeChars),
    verify_before_booking: raw.verify_before_booking.slice(0, PL.maxVerifyItems).map((s) => limit(s)),
    assumptions: raw.assumptions.slice(0, PL.maxAssumptions).map((s) => limit(s)),
  };

  return { ok: true, value, warnings };
}
