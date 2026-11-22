// Every limit, price and model setting for the Worker. Values come from SPEC.md
// sections 4.4 and 4.7 to 4.9. Nothing else in the Worker should hard-code these.

export const VERSION = '1.0.0';

// ---- 4.4 Request bodies -------------------------------------------------------
export const BODY_LIMIT_BYTES = {
  start: 8 * 1024,
  plan: 16 * 1024, // the session token rides in this body (raised from 8 KB, SPEC.md v3)
  revise: 64 * 1024,
};

// ---- 4.7 Input validation: the brief ------------------------------------------
export const BRIEF_LIMITS = {
  destination: { min: 2, max: 60 },
  origin: { min: 2, max: 40 },
  travellers: { min: 1, max: 8 },
  nights: { min: 2, max: 21 },
  month: { min: 0, max: 12 }, // 0 means flexible
  yearsAhead: 2, // this UTC year to this year plus 2
  budgetPerPersonAud: { notSure: 0, min: 300, max: 30000 },
  interests: { min: 0, max: 200 },
  notes: { min: 0, max: 300 },
};
export const DEFAULT_ORIGIN = 'Brisbane';
export const GOALS = ['cheapest', 'best_value', 'best_location', 'most_comfortable'];
export const PACES = ['relaxed', 'balanced', 'packed'];
export const REVISE_REQUEST_LIMITS = { min: 3, max: 300 };
export const TURNSTILE_TOKEN_LIMITS = { min: 1, max: 2048 };

// ---- 4.7 Output: questions ----------------------------------------------------
export const QUESTIONS_LIMITS = {
  minQuestions: 2,
  maxQuestions: 4,
  minOptions: 2,
  maxOptions: 4,
  maxAssumptions: 4,
  textChars: 200,
  whyChars: 200,
  optionChars: 120,
  assumptionChars: 200,
};

// ---- 4.7 Output: plan ---------------------------------------------------------
export const PLAN_LIMITS = {
  minRouteStops: 1,
  maxRouteStops: 6,
  minDays: 1,
  maxDays: 22,
  minBudgetItems: 4,
  maxBudgetItems: 25,
  minUnits: 1,
  maxUnits: 100,
  maxUnitCostAud: 50000,
  minRouteNights: 1,
  maxLevers: 5,
  maxVerifyItems: 8,
  maxAssumptions: 6,
  titleChars: 80,
  dayPlanChars: 300,
  noteChars: 160,
  honestTakeChars: 600,
  otherChars: 240,
};
export const REQUIRED_CATEGORIES = ['flights', 'accommodation', 'food'];

// ---- 4.7 Contingency ----------------------------------------------------------
export const CONTINGENCY_PCT = 10;
export const CONTINGENCY_FAR_PCT = 15;
export const CONTINGENCY_FAR_MONTHS = 12;

// ---- 4.8 Counters and caps ----------------------------------------------------
export const VISITOR_BURST_PER_MINUTE = 10;
export const VISITOR_TRIPS_PER_DAY = 3;
export const VISITOR_CALLS_PER_DAY = 12;
export const GLOBAL_DAILY_CALLS = 120;
export const GLOBAL_DAILY_MICRO_USD = 350000;
export const GLOBAL_MONTHLY_CALLS = 1500;
export const GLOBAL_MONTHLY_MICRO_USD = 4500000;

export const COUNTER_TTL_SECONDS = {
  burst: 2 * 60,
  daily: 2 * 24 * 60 * 60,
  monthly: 40 * 24 * 60 * 60,
};
export const USAGE_LOG_RETENTION_DAYS = 90;
export const IP_HASH_HEX_CHARS = 24;

// US dollars per million tokens, so micro-dollars = ceil(in * priceIn + out * priceOut).
export const PRICES = {
  'claude-haiku-5-5': { in: 0.10, out: 0.50 },
  'claude-sonnet-5-5': { in: 2, out: 10 },
};

// ---- 4.8 Session tokens -------------------------------------------------------
export const SESSION_VERSION = 1;
export const SESSION_TTL_SECONDS = 7200;
export const MAX_REVISIONS = 2;
export const SESSION_SECRET_MIN_CHARS = 32;

// ---- Task 9 Turnstile -----------------------------------------------------------
export const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
// Not set by the spec. A slow check fails closed (challenge_failed) after this long.
export const TURNSTILE_TIMEOUT_MS = 10000;

// ---- 4.9 Calling Claude -------------------------------------------------------
export const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
export const UPSTREAM_TIMEOUT_MS = 90000;
export const MODEL_SETTINGS = {
  start: { max_tokens: 2000, effort: 'low' },
  plan: { max_tokens: 8000, effort: 'medium' },
  revise: { max_tokens: 8000, effort: 'medium' },
};

// Mock mode (MOCK_ANTHROPIC=1).
export const MOCK_DELAY_MS = 300;
export const MOCK_SLOW_DELAY_MS = 5000;
export const MOCK_USAGE = {
  start: { input_tokens: 3050, output_tokens: 800 },
  plan: { input_tokens: 4150, output_tokens: 4500 },
  revise: { input_tokens: 4150, output_tokens: 4500 },
};
