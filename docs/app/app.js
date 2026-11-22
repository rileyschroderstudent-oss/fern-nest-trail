// Screens, state and rendering for the TRAIL demo (SPEC.md Task 3).
// Every piece of model-written text goes on the page with textContent only.
import {
  getStatus,
  startTrip,
  planTrip,
  reviseTrip,
  errorText,
  DECLINE_TEXT,
  RETRYABLE,
  rateLimitText,
  isBurst,
} from './api.js';
import { computeBudget, fitVerdict } from './budget.js';
import { CONFIG } from './config.js';

const STORAGE_KEY = 'fnt-trail-state-v1';

// Must equal APP_VERSION in index.html (loader.test.mjs checks). A stale cached
// index.html can be served new modules, because GitHub Pages ignores ?v= and serves
// the current file. When the page and the modules disagree, the page reloads once
// to ./?v=<MODULE_VERSION>, a URL with no cached copy, so a fresh index.html arrives.
const MODULE_VERSION = '2026-11-22.4';
const $ = (id) => document.getElementById(id);

// ---- Small DOM helpers ----------------------------------------------------------

// Builds an element. props.text sets textContent; props.class sets className; any
// other prop becomes an attribute. Children are nodes or strings (as text nodes).
function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'text') node.textContent = String(value);
    else if (key === 'class') node.className = value;
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

const audExact = (n) => `A$${Number(n).toLocaleString('en-AU')}`;
// Ends text with a full stop unless it already ends with . ! or ? (ignoring trailing spaces).
const sentence = (s) => { const t = String(s).trimEnd(); return /[.!?]$/.test(t) ? t : `${t}.`; };
// Computed figures are rounded to the nearest A$10 for display only.
const round10 = (n) => Math.round(n / 10) * 10;
const est = (n) => `est. ${audExact(round10(n))}`;
const estRange = (low, high) =>
  `est. ${audExact(round10(low))}–${round10(high).toLocaleString('en-AU')}`;
// Unit costs come straight from the model; they are shown as given.
const estUnit = (low, high) =>
  low === high ? `est. ${audExact(low)}` : `est. ${audExact(low)}–${Number(high).toLocaleString('en-AU')}`;

const localTime = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(d);
};

// ---- State ----------------------------------------------------------------------

const DEFAULT_FORM = {
  destination: '',
  origin: 'Brisbane',
  travellers: '',
  nights: '',
  month: '0',
  year: String(new Date().getUTCFullYear()),
  budgetPerPersonAud: '',
  budgetUnsure: false,
  goal: 'best_value',
  pace: 'balanced',
  interests: '',
  notes: '',
};

const state = {
  screen: 'brief', // 'brief' | 'questions' | 'plan'
  form: { ...DEFAULT_FORM },
  questions: null, // the /start response
  answers: {}, // questionId -> optionId
  plan: null, // the /plan or /revise response, kept exactly as received
  reviseText: '', // the change request being typed, kept through errors
  model: null,
  mock: false,
};

let busy = false;
let statusInfo = null;

function save() {
  try {
    const { screen, form, questions, answers, plan, reviseText } = state;
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ screen, form, questions, answers, plan, reviseText }));
  } catch {
    // Storage can be full or blocked; the page still works without it.
  }
}

function restore() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null');
    if (!saved || typeof saved !== 'object') return;
    if (saved.form && typeof saved.form === 'object') state.form = { ...DEFAULT_FORM, ...saved.form };
    if (saved.questions && saved.questions.type === 'questions') state.questions = saved.questions;
    if (saved.answers && typeof saved.answers === 'object') state.answers = saved.answers;
    if (saved.plan && saved.plan.type === 'plan') state.plan = saved.plan;
    if (typeof saved.reviseText === 'string') state.reviseText = saved.reviseText;
    if (saved.screen === 'plan' && state.plan) state.screen = 'plan';
    else if (saved.screen === 'questions' && state.questions) state.screen = 'questions';
    else state.screen = 'brief';
  } catch {
    // Ignore unreadable storage and start fresh.
  }
}

// ---- Screens and notices ----------------------------------------------------------

const SCREENS = {
  brief: { section: 'screen-brief', heading: 'brief-heading' },
  questions: { section: 'screen-questions', heading: 'questions-heading' },
  plan: { section: 'screen-plan', heading: 'plan-title' },
};

function showScreen(name, { focus = true } = {}) {
  state.screen = name;
  for (const [key, s] of Object.entries(SCREENS)) $(s.section).hidden = key !== name;
  if (name === 'questions') renderQuestions();
  if (name === 'plan') renderPlan();
  save();
  if (focus) $(SCREENS[name].heading).focus();
  window.scrollTo(0, 0);
}

// The notice area holds one message at a time: fixed text, an optional Retry button,
// and for a burst limit a countdown that updates once a second.
let noticeTimer = null;

function showNotice(text, { retry = null, focus = true } = {}) {
  clearNotice();
  const notice = $('notice');
  const message = el('p', { class: 'notice-text', text });
  notice.append(message);
  if (retry) {
    const button = el('button', { class: 'btn btn-secondary', type: 'button', text: 'Retry' });
    button.addEventListener('click', () => {
      if (busy) return;
      clearNotice();
      retry();
    });
    notice.append(el('div', { class: 'actions' }, [button]));
  }
  notice.hidden = false;
  if (focus) notice.focus();
  return message;
}

function clearNotice() {
  if (noticeTimer !== null) clearInterval(noticeTimer);
  noticeTimer = null;
  $('notice').hidden = true;
  $('notice').replaceChildren();
}

function showRateLimited(retryAfterSeconds) {
  const fmt = (d) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(d);
  const endsAt = Date.now() + (Number(retryAfterSeconds) || 0) * 1000;
  const left = () => Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
  const message = showNotice(rateLimitText(left(), retryAfterSeconds, fmt));
  if (!isBurst(retryAfterSeconds)) return;
  noticeTimer = setInterval(() => {
    message.textContent = rateLimitText(left(), retryAfterSeconds, fmt);
    if (left() === 0) {
      clearInterval(noticeTimer);
      noticeTimer = null;
    }
  }, 1000);
}

// The closed panel replaces the Brief and Questions forms. A plan already on screen
// stays readable.
function showClosed(reason, reopensAt, { focus = false } = {}) {
  const when = reopensAt ? localTime(reopensAt) : '';
  let text;
  if (reason === 'paused') text = 'The demo is paused. Try again later.';
  else if (when) text = `The demo has hit its budget and reopens at ${when}, your local time.`;
  else text = 'The demo has hit its budget and is closed for now.';
  $('closed-text').textContent = text;
  $('closed').hidden = false;
  $('brief-form').hidden = true;
  $('questions-form').hidden = true;
  $('revise-form').hidden = true;
  if (focus) $('closed-heading').focus();
}

// Shows "Working... N s" in a polite live region while a request runs.
function startWorking(button, region) {
  busy = true;
  button.disabled = true;
  const started = Date.now();
  const tick = () => {
    const secs = Math.floor((Date.now() - started) / 1000);
    region.textContent = `Working... ${secs} s. Plans usually take under a minute.`;
  };
  tick();
  const timer = setInterval(tick, 1000);
  return () => {
    clearInterval(timer);
    region.textContent = '';
    busy = false;
    button.disabled = false;
  };
}

// ---- Brief ------------------------------------------------------------------------

const FORM_FIELDS = ['destination', 'origin', 'travellers', 'nights', 'month', 'year',
  'budgetPerPersonAud', 'goal', 'pace', 'interests', 'notes'];

const input = (name) => $('brief-form').elements.namedItem(name);

function writeForm() {
  for (const name of FORM_FIELDS) input(name).value = state.form[name] ?? '';
  $('f-budget-unsure').checked = Boolean(state.form.budgetUnsure);
  syncBudgetUnsure();
  updateCounter('interests', 200);
  updateCounter('notes', 300);
}

function readFormIntoState() {
  for (const name of FORM_FIELDS) state.form[name] = input(name).value;
  state.form.budgetUnsure = $('f-budget-unsure').checked;
}

function syncBudgetUnsure() {
  const unsure = $('f-budget-unsure').checked;
  const budget = $('f-budget');
  budget.disabled = unsure;
  budget.required = !unsure;
}

function updateCounter(name, max) {
  const length = Array.from(input(name).value).length;
  $(`c-${name}`).textContent = `${length} / ${max}`;
}

function setFieldError(name, text) {
  const field = document.querySelector(`.field[data-field="${name}"]`);
  const message = $(`e-${name}`);
  if (!field || !message) return;
  message.textContent = text || '';
  field.classList.toggle('invalid', Boolean(text));
  const control = field.querySelector('input:not([type=checkbox]), select, textarea');
  if (control) control.setAttribute('aria-invalid', text ? 'true' : 'false');
}

function clearFieldErrors() {
  for (const name of FORM_FIELDS) setFieldError(name, '');
}

const FIELD_RULES = {
  destination: 'Enter 2 to 60 characters.',
  origin: 'Enter 2 to 40 characters.',
  travellers: 'Enter a whole number from 1 to 8.',
  nights: 'Enter a whole number from 2 to 21.',
  month: 'That month has already passed. Pick a later month or year.',
  year: 'Enter a year from this year to two years ahead.',
  budgetPerPersonAud: 'Enter a whole number from 300 to 30,000, or tick Not sure.',
  interests: 'Keep it to 200 characters.',
  notes: 'Keep it to 300 characters.',
};

// Browser-side checks that mirror the 4.7 limits. The Worker checks everything again.
function checkForm() {
  clearFieldErrors();
  const bad = [];
  for (const name of Object.keys(FIELD_RULES)) {
    const control = input(name);
    if (control.disabled) continue;
    const trimmed = control.value.trim();
    let ok = control.checkValidity();
    if (ok && control.type === 'text' && control.required) ok = trimmed.length >= Number(control.minLength);
    if (!ok) bad.push([name, FIELD_RULES[name]]);
  }
  const month = Number(input('month').value);
  const year = Number(input('year').value);
  const now = new Date();
  if (month !== 0 && year === now.getUTCFullYear() && month < now.getUTCMonth() + 1) {
    bad.push(['month', 'That month has already passed. Pick a later month or year.']);
  }
  for (const [name, text] of bad) setFieldError(name, text);
  if (bad.length) input(bad[0][0]).focus();
  return bad.length === 0;
}

function briefFromForm() {
  const f = state.form;
  return {
    destination: f.destination,
    origin: f.origin,
    travellers: Number(f.travellers),
    nights: Number(f.nights),
    month: Number(f.month),
    year: Number(f.year),
    budgetPerPersonAud: f.budgetUnsure ? 0 : Number(f.budgetPerPersonAud),
    goal: f.goal,
    pace: f.pace,
    interests: f.interests,
    notes: f.notes,
  };
}

function showServerFieldErrors(error) {
  const fields = Array.isArray(error?.fields) ? error.fields : [];
  let first = null;
  for (const f of fields) {
    const name = typeof f?.name === 'string' ? f.name.replace(/^brief\./, '') : '';
    if (!FORM_FIELDS.includes(name)) continue;
    setFieldError(name, FIELD_RULES[name] || 'Check this field.');
    first = first || name;
  }
  return first;
}

// ---- Turnstile (SPEC.md Task 9) ------------------------------------------------------
// index.html loads api.js from Cloudflare with render=explicit; the widget is drawn
// here with the site key from config.js. A token works once and expires after five
// minutes, so the widget is reset after every /start response.

let turnstileWidget = null;
let turnstileToken = '';

const CHECK_NOT_READY = "The browser check hasn't finished yet. Wait a moment and try again. If no check appears, reload the page.";

// How long a Retry on /start waits for the widget to produce a fresh token.
const TOKEN_WAIT_MS = 30000;
let tokenWaiters = [];

function tokenArrived(token) {
  turnstileToken = token;
  const waiters = tokenWaiters;
  tokenWaiters = [];
  for (const resolve of waiters) resolve(token);
}

// Resolves with a token, or with '' if none arrives in time.
function waitForToken() {
  if (turnstileToken) return Promise.resolve(turnstileToken);
  return new Promise((resolve) => {
    tokenWaiters.push(resolve);
    setTimeout(() => {
      tokenWaiters = tokenWaiters.filter((r) => r !== resolve);
      resolve('');
    }, TOKEN_WAIT_MS);
  });
}

function renderTurnstile() {
  if (turnstileWidget !== null || !window.turnstile) return;
  turnstileWidget = window.turnstile.render('#turnstile', {
    sitekey: CONFIG.turnstileSiteKey,
    callback: tokenArrived,
    'expired-callback': () => { turnstileToken = ''; },
    'error-callback': () => { turnstileToken = ''; },
  });
}

function setupTurnstile() {
  if (window.turnstile) renderTurnstile();
  else $('turnstile-api').addEventListener('load', renderTurnstile);
}

function resetTurnstile() {
  turnstileToken = '';
  if (window.turnstile && turnstileWidget !== null) window.turnstile.reset(turnstileWidget);
}

async function onBriefSubmit(event) {
  event.preventDefault();
  if (busy) return;
  clearNotice();
  readFormIntoState();
  save();
  if (!checkForm()) return;

  if (!turnstileToken) return showNotice(CHECK_NOT_READY);
  return sendStart(briefFromForm(), turnstileToken);
}

// Sends /start. A Retry resends the same brief with a fresh token, waiting for the
// widget to produce one first.
async function sendStart(brief, token) {
  if (busy) return undefined;
  const done = startWorking($('brief-submit'), $('brief-working'));
  let tokenToSend = token;
  if (!tokenToSend) tokenToSend = await waitForToken();
  if (!tokenToSend) {
    done();
    return showNotice(CHECK_NOT_READY);
  }
  turnstileToken = ''; // a token works once
  const result = await startTrip({ brief, turnstileToken: tokenToSend });
  done();
  resetTurnstile(); // after every /start response, success or failure

  if (!result.ok) return handleError(result, 'brief', () => sendStart(brief, ''));
  const data = result.data;
  if (data.type === 'declined') return showNotice(DECLINE_TEXT[data.reason] || DECLINE_TEXT.other);
  if (data.type !== 'questions' || !Array.isArray(data.questions)) return showNotice(errorText('bad_model_output'));

  state.questions = data;
  state.answers = {};
  state.plan = null;
  showScreen('questions');
}

// ---- Questions --------------------------------------------------------------------

function allAnswered() {
  const qs = state.questions?.questions || [];
  return qs.length > 0 && qs.every((q) => q.options.some((o) => o.id === state.answers[q.id]));
}

function renderQuestions() {
  const data = state.questions;
  const assumptions = Array.isArray(data?.assumptions) ? data.assumptions : [];
  $('q-assumptions').replaceChildren(...assumptions.map((a) => el('li', { text: a })));
  $('q-assumptions').closest('.card').hidden = assumptions.length === 0;

  const list = $('q-list');
  list.replaceChildren();
  for (const q of data?.questions || []) {
    const hintId = `qh-${q.id}`;
    const fieldset = el('fieldset', { class: 'question', 'aria-describedby': hintId }, [
      el('legend', { text: q.text }),
      el('p', { class: 'hint', id: hintId, text: q.why }),
    ]);
    for (const o of q.options) {
      const id = `q-${q.id}-${o.id}`;
      const radio = el('input', { type: 'radio', name: q.id, value: o.id, id });
      radio.checked = state.answers[q.id] === o.id;
      radio.addEventListener('change', () => {
        state.answers[q.id] = o.id;
        save();
        $('questions-submit').disabled = !allAnswered() || isClosed();
      });
      fieldset.append(el('label', { class: 'option', for: id }, [radio, el('span', { text: o.label })]));
    }
    list.append(fieldset);
  }
  $('questions-submit').disabled = !allAnswered() || isClosed();
}

async function onQuestionsSubmit(event) {
  event.preventDefault();
  if (busy || !allAnswered()) return;
  clearNotice();

  const answers = state.questions.questions.map((q) => ({ questionId: q.id, optionId: state.answers[q.id] }));
  return sendPlan({ session: state.questions.session, answers });
}

// Sends /plan. A Retry resends exactly the same request.
async function sendPlan(request) {
  if (busy) return undefined;
  const done = startWorking($('questions-submit'), $('questions-working'));
  const result = await planTrip(request);
  done();
  $('questions-submit').disabled = !allAnswered() || isClosed();

  if (!result.ok) return handleError(result, 'questions', () => sendPlan(request));
  const data = result.data;
  if (data.type === 'declined') {
    showScreen('brief', { focus: false });
    return showNotice(DECLINE_TEXT[data.reason] || DECLINE_TEXT.other);
  }
  if (data.type !== 'plan' || !data.plan) return showNotice(errorText('bad_model_output'));

  state.plan = data;
  showScreen('plan');
}

// ---- Plan -------------------------------------------------------------------------

const CATEGORY_LABEL = {
  flights: 'Flights',
  accommodation: 'Accommodation',
  local_transport: 'Local transport',
  activities: 'Activities',
  food: 'Food',
  drinks: 'Drinks',
  connectivity: 'Connectivity',
  insurance: 'Travel insurance',
  entry_fees: 'Entry fees',
  other: 'Other',
};

const BASIS_LABEL = { per_person: 'Per person', per_group: 'Whole group' };

const WARNING_TEXT = {
  route_nights_mismatch: "The nights at each stop don't add up to the number of nights you asked for.",
  days_count_mismatch: "The day-by-day plan doesn't have one day for each day of your trip.",
  missing_flights: 'The budget has no line for flights, so the total is too low.',
  missing_accommodation: 'The budget has no line for accommodation, so the total is too low.',
  missing_food: 'The budget has no line for food, so the total is too low.',
};

const VERDICT_LABEL = {
  fits: 'Fits the budget',
  tight: 'Tight: up to 10% over',
  over: 'Over budget',
  no_budget: 'No budget given',
};

const TOTALS_UNAVAILABLE = 'Totals unavailable: budget.js is not implemented yet';

// Runs budget.js. Returns { budget, verdict } or null if it throws.
function computeTotals(data) {
  try {
    const budget = computeBudget(data.plan.budget_items, data.travellers, data.contingencyPct);
    const verdict = fitVerdict(budget.perPerson.mid, budget.perPerson.high, data.budgetPerPersonAud);
    return { budget, verdict };
  } catch {
    return null;
  }
}

function renderVerdict(data, totals) {
  const panel = $('plan-verdict');
  if (!totals) {
    panel.replaceChildren(el('p', { class: 'verdict-label', text: 'Totals unavailable' }), el('p', { text: TOTALS_UNAVAILABLE }));
    return;
  }
  const { budget, verdict } = totals;
  const children = [el('p', { class: 'verdict-label', text: VERDICT_LABEL[verdict.verdict] || 'Verdict' })];
  if (verdict.verdict === 'no_budget') {
    children.push(el('p', { text: "You didn't give a budget, so there is nothing to compare the estimate with." }));
  } else {
    const gap = Math.abs(verdict.gapAud);
    const side = verdict.gapAud > 0 ? 'over' : 'under';
    children.push(el('p', {
      text: `The middle estimate is ${est(budget.perPerson.mid)} per person against your budget of ${audExact(data.budgetPerPersonAud)}, ${est(gap)} ${side}.`,
    }));
    children.push(el('p', {
      text: verdict.fitsAtHighEnd
        ? 'It still fits at the high end of the estimates.'
        : "At the high end of the estimates it doesn't fit.",
    }));
  }
  const figure = (label, value) => el('div', {}, [el('dt', { text: label }), el('dd', { text: value })]);
  children.push(el('dl', { class: 'figures' }, [
    figure('Per person, middle', est(budget.perPerson.mid)),
    figure('Per person, range', estRange(budget.perPerson.low, budget.perPerson.high)),
    figure(`Group total, ${data.travellers} ${data.travellers === 1 ? 'traveller' : 'travellers'}`, estRange(budget.total.low, budget.total.high)),
    figure('Contingency included', `${data.contingencyPct}%`),
  ]));
  panel.replaceChildren(...children);
}

function renderBudget(data, totals) {
  const items = data.plan.budget_items;
  const head = el('thead', {}, [el('tr', {}, ['Item', 'Category', 'Basis', 'Units', 'Unit cost'].map((h, i) =>
    el('th', { scope: 'col', class: i >= 3 ? 'num' : null, text: h })))]);
  const body = el('tbody', {}, items.map((it) => el('tr', {}, [
    el('td', {}, [el('span', { text: it.label }), it.note ? el('span', { class: 'note', text: it.note }) : null]),
    el('td', { text: CATEGORY_LABEL[it.category] || it.category }),
    el('td', { text: BASIS_LABEL[it.basis] || it.basis }),
    el('td', { class: 'num', text: String(it.units) }),
    el('td', { class: 'num', text: estUnit(it.unit_low_aud, it.unit_high_aud) }),
  ])));
  const parts = [el('div', { class: 'table-wrap' }, [el('table', { class: 'table' }, [head, body])])];

  if (!totals) {
    parts.push(el('p', { class: 'unavailable', text: TOTALS_UNAVAILABLE }));
  } else {
    const { budget } = totals;
    const row = (label, t, tag = 'td') => el('tr', {}, [
      el('th', { scope: 'row', text: label }),
      el(tag, { class: 'num', text: est(t.low) }),
      el(tag, { class: 'num', text: est(t.mid) }),
      el(tag, { class: 'num', text: est(t.high) }),
    ]);
    const categories = [...new Set(items.map((it) => it.category))].filter((c) => budget.byCategory[c]);
    parts.push(el('h3', { class: 'totals-title', text: 'Totals for the group' }));
    parts.push(el('div', { class: 'table-wrap' }, [el('table', { class: 'table' }, [
      el('thead', {}, [el('tr', {}, ['Category', 'Low', 'Middle', 'High'].map((h, i) =>
        el('th', { scope: 'col', class: i ? 'num' : null, text: h })))]),
      el('tbody', {}, categories.map((c) => row(CATEGORY_LABEL[c] || c, budget.byCategory[c]))),
      el('tfoot', {}, [
        row('Subtotal', budget.subtotal),
        row(`Contingency (${data.contingencyPct}%)`, budget.contingency),
        row('Total', budget.total),
        row('Per person', budget.perPerson),
      ]),
    ])]));
  }
  $('plan-budget').replaceChildren(...parts);
}

// ---- Revise (SPEC.md Task 11) -----------------------------------------------------

const REVISE_MAX = 300;

function renderRevise() {
  const left = Number(state.plan?.revisionsLeft) || 0;
  const form = $('revise-form');
  form.hidden = left <= 0 || isClosed();
  if (form.hidden) return;
  $('h-revise').textContent = left === 1 ? '1 revision left.' : `${left} revisions left.`;
  $('f-revise').value = state.reviseText || '';
  updateReviseCounter();
}

function updateReviseCounter() {
  $('c-revise').textContent = `${Array.from($('f-revise').value).length} / ${REVISE_MAX}`;
}

function setReviseError(text) {
  $('e-revise').textContent = text;
  $('f-revise').setAttribute('aria-invalid', text ? 'true' : 'false');
}

async function onReviseSubmit(event) {
  event.preventDefault();
  if (busy) return;
  clearNotice();
  setReviseError('');
  const text = $('f-revise').value;
  state.reviseText = text;
  save();
  const length = Array.from(text.trim()).length;
  if (length < 3 || length > REVISE_MAX) {
    setReviseError(`Describe the change in 3 to ${REVISE_MAX} characters.`);
    $('f-revise').focus();
    return;
  }
  // The plan goes back exactly as it was received; computed totals live elsewhere.
  await sendRevise({ session: state.plan.session, plan: state.plan.plan, request: text });
}

// Sends /revise. A Retry resends exactly the same request.
async function sendRevise(request) {
  if (busy) return undefined;
  const done = startWorking($('revise-submit'), $('revise-working'));
  const result = await reviseTrip(request);
  done();

  if (!result.ok) {
    if (result.code === 'revisions_exhausted') {
      state.plan = { ...state.plan, revisionsLeft: 0 };
      save();
      renderRevise();
      return showNotice(errorText('revisions_exhausted'));
    }
    if (result.code === 'invalid_input') {
      setReviseError(`Describe the change in 3 to ${REVISE_MAX} characters.`);
      return showNotice(errorText('invalid_input'));
    }
    return handleError(result, 'plan', () => sendRevise(request));
  }
  const data = result.data;
  if (data.type === 'declined') return showNotice(DECLINE_TEXT[data.reason] || DECLINE_TEXT.other);
  if (data.type !== 'plan' || !data.plan) return showNotice(errorText('bad_model_output'));

  state.plan = data;
  state.reviseText = '';
  showScreen('plan');
  return undefined;
}

function renderPlan() {
  const data = state.plan;
  if (!data) return;
  const p = data.plan;
  const totals = computeTotals(data);

  $('plan-title').textContent = p.title;
  $('plan-route').replaceChildren(...p.route.map((s) =>
    el('li', { text: `${s.place} · ${s.nights} ${s.nights === 1 ? 'night' : 'nights'}` })));
  $('plan-season').textContent = p.season_note;

  renderVerdict(data, totals);
  renderBudget(data, totals);

  $('plan-honest').textContent = p.honest_take;

  $('plan-levers').replaceChildren(...p.levers.map((l) =>
    el('li', { text: `${sentence(l.change)} Saves about est. ${audExact(l.saves_per_person_aud)} per person.` })));
  $('plan-levers').closest('.card').hidden = p.levers.length === 0;

  $('plan-days').replaceChildren(...p.days.map((d) => el('tr', {}, [
    el('td', { class: 'num', text: String(d.day) }),
    el('td', { text: d.base }),
    el('td', { text: d.plan }),
  ])));

  $('plan-stays').replaceChildren(...p.route.map((s) => el('div', { class: 'stay' }, [
    el('h3', { text: s.place }),
    el('p', { class: 'meta', text: `${s.nights} ${s.nights === 1 ? 'night' : 'nights'} · ${s.stay_type}` }),
    el('p', {}, [el('strong', { text: 'Area: ' }), s.area_to_stay]),
    el('p', { text: s.area_reason }),
  ])));

  const flights = [['Routing', p.flights.routing], ['Timing', p.flights.timing], ['Peak dates', p.flights.peak_warning]]
    .filter(([, text]) => text);
  $('plan-flights').replaceChildren(...flights.flatMap(([label, text]) => [el('dt', { text: label }), el('dd', { text })]));

  $('plan-verify').replaceChildren(...p.verify_before_booking.map((v) => el('li', { text: v })));
  $('plan-assumptions').replaceChildren(...p.assumptions.map((a) => el('li', { text: a })));
  $('plan-assumptions').closest('.card').hidden = p.assumptions.length === 0;

  const warnings = Array.isArray(data.warnings) ? data.warnings : [];
  $('plan-warnings').replaceChildren(...warnings.map((w) =>
    el('li', { text: WARNING_TEXT[w] || 'Part of this plan did not pass a consistency check.' })));
  $('plan-warnings-card').hidden = warnings.length === 0;

  const model = state.model ? `${state.model}${state.mock ? ' (mock mode, canned answers)' : ''}` : 'unknown';
  $('plan-meta').textContent = `Generated ${localTime(data.generatedAt) || 'just now'} · Model: ${model}`;
  renderRevise();
}

// ---- Errors -----------------------------------------------------------------------

function isClosed() {
  return statusInfo !== null && statusInfo.open === false;
}

// Drops the trip in progress (questions, answers, plan) but keeps the form values.
function clearTrip() {
  state.questions = null;
  state.answers = {};
  state.plan = null;
  state.reviseText = '';
  save();
}

// Shows a failed request (SPEC.md 4.4 and Task 10). Only fixed text is shown, the
// form values are always kept, and nothing retries by itself: a Retry is a paid call.
// `retry` resends the same request.
function handleError(result, screen, retry) {
  const { code, error } = result;
  switch (code) {
    case 'demo_closed':
      clearNotice();
      showClosed(null, error?.reopensAt ?? null, { focus: true });
      loadStatus({ quiet: true }); // learns whether it is paused or over budget
      return undefined;
    case 'rate_limited':
      return showRateLimited(error?.retryAfterSeconds);
    case 'invalid_session':
    case 'session_expired':
      clearTrip();
      showScreen('brief', { focus: false });
      return showNotice(errorText(code));
    case 'invalid_input':
      if (screen === 'brief') {
        const first = showServerFieldErrors(result.error);
        showNotice(errorText('invalid_input'), { focus: !first });
        if (first) input(first).focus();
        return undefined;
      }
      return showNotice(errorText('internal_error'));
    default:
      if (RETRYABLE.has(code) && retry) return showNotice(errorText(code), { retry });
      return showNotice(errorText(code));
  }
}

// ---- Start-up ---------------------------------------------------------------------

function resetToNewTrip() {
  state.form = { ...DEFAULT_FORM };
  state.questions = null;
  state.answers = {};
  state.plan = null;
  state.reviseText = '';
  writeForm();
  clearFieldErrors();
  clearNotice();
  showScreen('brief');
}

async function loadStatus({ quiet = false } = {}) {
  const result = await getStatus();
  if (!result.ok) {
    if (!quiet) showNotice(errorText(result.code), { focus: false });
    return;
  }
  statusInfo = result.data;
  state.model = typeof statusInfo.model === 'string' ? statusInfo.model : null;
  state.mock = statusInfo.mock === true;
  if (statusInfo.open === false) showClosed(statusInfo.reason, statusInfo.reopensAt);
  if (state.screen === 'plan') renderPlan();
}

// True when index.html and the modules are the same version. Otherwise reloads once,
// or, if this load already came from that reload, shows the load-error message so
// mixed versions never run. The ?v= in the page URL is the loop guard: it needs no
// storage, so it also works when sessionStorage is blocked.
function versionMatches() {
  if (window.FNT_APP_VERSION === MODULE_VERSION) return true;
  const url = new URL(window.location.href);
  if (url.searchParams.get('v') !== MODULE_VERSION) {
    url.searchParams.set('v', MODULE_VERSION);
    window.location.replace(url.toString());
  } else {
    $('load-error').hidden = false;
  }
  return false;
}

function init() {
  if (!versionMatches()) return;

  const thisYear = new Date().getUTCFullYear();
  const year = $('f-year');
  year.min = String(thisYear);
  year.max = String(thisYear + 2);

  restore();
  writeForm();

  const form = $('brief-form');
  form.addEventListener('submit', onBriefSubmit);
  form.addEventListener('input', () => {
    readFormIntoState();
    updateCounter('interests', 200);
    updateCounter('notes', 300);
    save();
  });
  $('f-budget-unsure').addEventListener('change', () => {
    syncBudgetUnsure();
    setFieldError('budgetPerPersonAud', '');
    readFormIntoState();
    save();
  });

  $('questions-form').addEventListener('submit', onQuestionsSubmit);
  $('questions-restart').addEventListener('click', () => {
    state.questions = null;
    state.answers = {};
    clearNotice();
    showScreen('brief');
  });

  $('plan-new').addEventListener('click', resetToNewTrip);
  $('plan-print').addEventListener('click', () => window.print());
  $('revise-form').addEventListener('submit', onReviseSubmit);
  $('f-revise').addEventListener('input', () => {
    state.reviseText = $('f-revise').value;
    updateReviseCounter();
    save();
  });

  // The button ships disabled in index.html, so a page whose script failed to load
  // cannot be submitted. It is usable from here on.
  $('brief-submit').disabled = false;

  showScreen(state.screen, { focus: false });
  setupTurnstile();
  loadStatus();
}

init();
