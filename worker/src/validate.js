// Input validation and sanitising (SPEC.md 4.7, "Input: the brief").
// Every validator returns { ok: true, value } or { ok: false, fields }, where fields
// lists each { name, problem }. Types are never coerced: "4" is not a number.
import {
  BRIEF_LIMITS as L,
  GOALS,
  PACES,
  REVISE_REQUEST_LIMITS,
  TURNSTILE_TOKEN_LIMITS,
} from './config.js';

// Problem codes used in `fields`.
export const PROBLEM = {
  required: 'required',
  wrongType: 'wrong_type',
  tooShort: 'too_short',
  tooLong: 'too_long',
  outOfRange: 'out_of_range',
  notAllowed: 'not_allowed',
  inThePast: 'in_the_past',
  unknownField: 'unknown_field',
  wrongCount: 'wrong_count',
  duplicate: 'duplicate',
  unknownQuestion: 'unknown_question',
  unknownOption: 'unknown_option',
};

const BRIEF_FIELDS = ['destination', 'origin', 'travellers', 'nights', 'month', 'year',
  'budgetPerPersonAud', 'goal', 'pace', 'interests', 'notes'];

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const length = (s) => Array.from(s).length; // code points, so an emoji counts once

// Cleans a string: every whitespace run (tabs and newlines included) becomes one
// space, the remaining control characters (U+0000-U+001F, U+007F) and < > are
// removed, then spaces are collapsed and the ends trimmed again.
export function cleanString(s) {
  return s
    .replace(/\s+/g, ' ')
    .replace(/[\u0000-\u001F\u007F<>]/g, '')
    .replace(/ {2,}/g, ' ')
    .trim();
}

// Checks a string field after cleaning. Returns [value, problem].
function checkString(raw, { min, max }) {
  if (typeof raw !== 'string') return [undefined, PROBLEM.wrongType];
  const value = cleanString(raw);
  const n = length(value);
  if (n < min) return [value, PROBLEM.tooShort];
  if (n > max) return [value, PROBLEM.tooLong];
  return [value, null];
}

function checkInteger(raw, min, max) {
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return [undefined, PROBLEM.wrongType];
  if (raw < min || raw > max) return [raw, PROBLEM.outOfRange];
  return [raw, null];
}

function checkEnum(raw, allowed) {
  if (typeof raw !== 'string') return [undefined, PROBLEM.wrongType];
  return allowed.includes(raw) ? [raw, null] : [raw, PROBLEM.notAllowed];
}

function unknownKeys(obj, allowed, prefix = '') {
  return Object.keys(obj)
    .filter((k) => !allowed.includes(k))
    .map((k) => ({ name: prefix + k, problem: PROBLEM.unknownField }));
}

// validateBrief(input, now): the brief object from /start. `now` is a Date, passed in
// so the year and past-month rules are deterministic in tests.
export function validateBrief(input, now) {
  if (input === undefined) return { ok: false, fields: [{ name: 'brief', problem: PROBLEM.required }] };
  if (!isPlainObject(input)) return { ok: false, fields: [{ name: 'brief', problem: PROBLEM.wrongType }] };

  const fields = unknownKeys(input, BRIEF_FIELDS, 'brief.');
  const value = {};
  const check = (name, fn) => {
    if (!Object.hasOwn(input, name)) {
      fields.push({ name, problem: PROBLEM.required });
      return;
    }
    const [v, problem] = fn(input[name]);
    if (problem) fields.push({ name, problem });
    else value[name] = v;
  };

  const thisYear = now.getUTCFullYear();

  check('destination', (v) => checkString(v, L.destination));
  check('origin', (v) => checkString(v, L.origin));
  check('travellers', (v) => checkInteger(v, L.travellers.min, L.travellers.max));
  check('nights', (v) => checkInteger(v, L.nights.min, L.nights.max));
  check('month', (v) => checkInteger(v, L.month.min, L.month.max));
  check('year', (v) => checkInteger(v, thisYear, thisYear + L.yearsAhead));
  check('budgetPerPersonAud', (v) => {
    const b = L.budgetPerPersonAud;
    if (typeof v !== 'number' || !Number.isInteger(v)) return [undefined, PROBLEM.wrongType];
    return v === b.notSure || (v >= b.min && v <= b.max) ? [v, null] : [v, PROBLEM.outOfRange];
  });
  check('goal', (v) => checkEnum(v, GOALS));
  check('pace', (v) => checkEnum(v, PACES));
  check('interests', (v) => checkString(v, L.interests));
  check('notes', (v) => checkString(v, L.notes));

  // A set month must not be in the past. Only checked when month and year are both
  // valid, so a bad field gets one entry.
  if (Object.hasOwn(value, 'month') && Object.hasOwn(value, 'year') && value.month !== 0) {
    if (value.year === thisYear && value.month < now.getUTCMonth() + 1) {
      delete value.month;
      fields.push({ name: 'month', problem: PROBLEM.inThePast });
    }
  }

  if (fields.length) return { ok: false, fields };
  // Return the fields in the spec's order.
  return { ok: true, value: Object.fromEntries(BRIEF_FIELDS.map((k) => [k, value[k]])) };
}

// validateAnswers(input, questions): the answers array from /plan, checked against
// the questions in the session token ([{ id, options: [{ id }] }]). Exactly one
// answer per question, with ids that exist. The value is in question order.
export function validateAnswers(input, questions) {
  if (input === undefined) return { ok: false, fields: [{ name: 'answers', problem: PROBLEM.required }] };
  if (!Array.isArray(input)) return { ok: false, fields: [{ name: 'answers', problem: PROBLEM.wrongType }] };

  const fields = [];
  const byQuestion = new Map(questions.map((q) => [q.id, q]));
  const chosen = new Map();

  input.forEach((entry, i) => {
    const name = `answers[${i}]`;
    if (!isPlainObject(entry)) return fields.push({ name, problem: PROBLEM.wrongType });
    const extra = unknownKeys(entry, ['questionId', 'optionId'], `${name}.`);
    if (extra.length) return fields.push(...extra);
    const { questionId, optionId } = entry;
    if (typeof questionId !== 'string' || typeof optionId !== 'string') {
      return fields.push({ name, problem: PROBLEM.wrongType });
    }
    const question = byQuestion.get(questionId);
    if (!question) return fields.push({ name, problem: PROBLEM.unknownQuestion });
    if (!question.options.some((o) => o.id === optionId)) return fields.push({ name, problem: PROBLEM.unknownOption });
    if (chosen.has(questionId)) return fields.push({ name, problem: PROBLEM.duplicate });
    chosen.set(questionId, optionId);
    return undefined;
  });

  if (!fields.length && chosen.size !== questions.length) fields.push({ name: 'answers', problem: PROBLEM.wrongCount });
  if (fields.length) return { ok: false, fields };
  return { ok: true, value: questions.map((q) => ({ questionId: q.id, optionId: chosen.get(q.id) })) };
}

function checkSession(body, fields) {
  if (!Object.hasOwn(body, 'session')) fields.push({ name: 'session', problem: PROBLEM.required });
  else if (typeof body.session !== 'string' || body.session.length === 0) {
    fields.push({ name: 'session', problem: PROBLEM.wrongType });
  }
}

// validateStartBody(body, now): the whole /start body, { brief, turnstileToken }.
export function validateStartBody(body, now) {
  const fields = unknownKeys(body, ['brief', 'turnstileToken']);
  const brief = validateBrief(body.brief, now);
  if (!brief.ok) fields.push(...brief.fields);

  const token = body.turnstileToken;
  if (token === undefined) fields.push({ name: 'turnstileToken', problem: PROBLEM.required });
  else if (typeof token !== 'string') fields.push({ name: 'turnstileToken', problem: PROBLEM.wrongType });
  else if (length(token) < TURNSTILE_TOKEN_LIMITS.min) fields.push({ name: 'turnstileToken', problem: PROBLEM.tooShort });
  else if (length(token) > TURNSTILE_TOKEN_LIMITS.max) fields.push({ name: 'turnstileToken', problem: PROBLEM.tooLong });

  if (fields.length) return { ok: false, fields };
  return { ok: true, value: { brief: brief.value, turnstileToken: token } };
}

// validatePlanBody(body): the /plan body's shape, { session, answers }. The answers
// are checked against the token's questions with validateAnswers once the token
// carries them (Task 6).
export function validatePlanBody(body) {
  const fields = unknownKeys(body, ['session', 'answers']);
  checkSession(body, fields);
  if (!Object.hasOwn(body, 'answers')) fields.push({ name: 'answers', problem: PROBLEM.required });
  else if (!Array.isArray(body.answers)) fields.push({ name: 'answers', problem: PROBLEM.wrongType });
  if (fields.length) return { ok: false, fields };
  return { ok: true, value: { session: body.session, answers: body.answers } };
}

// validateRevision(input): the whole /revise body, { session, plan, request }. The
// request is 3-300 characters after cleaning; the plan must be an object.
export function validateRevision(input) {
  if (!isPlainObject(input)) return { ok: false, fields: [{ name: 'body', problem: PROBLEM.wrongType }] };
  const fields = unknownKeys(input, ['session', 'plan', 'request']);
  checkSession(input, fields);

  if (!Object.hasOwn(input, 'plan')) fields.push({ name: 'plan', problem: PROBLEM.required });
  else if (!isPlainObject(input.plan)) fields.push({ name: 'plan', problem: PROBLEM.wrongType });

  let request;
  if (!Object.hasOwn(input, 'request')) fields.push({ name: 'request', problem: PROBLEM.required });
  else {
    const [v, problem] = checkString(input.request, REVISE_REQUEST_LIMITS);
    if (problem) fields.push({ name: 'request', problem });
    else request = v;
  }

  if (fields.length) return { ok: false, fields };
  return { ok: true, value: { session: input.session, plan: input.plan, request } };
}
