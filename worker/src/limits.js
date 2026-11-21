// Counters, caps and the usage log (SPEC.md 2 "Rate limits and caps" and 4.8).
// All dates are UTC and all money is in whole micro-dollars (integers only).
import * as C from './config.js';

// ---- Limits, with the mock-only LIMIT_OVERRIDES ---------------------------------

export const LIMIT_NAMES = [
  'VISITOR_BURST_PER_MINUTE',
  'VISITOR_TRIPS_PER_DAY',
  'VISITOR_CALLS_PER_DAY',
  'GLOBAL_DAILY_CALLS',
  'GLOBAL_DAILY_MICRO_USD',
  'GLOBAL_MONTHLY_CALLS',
  'GLOBAL_MONTHLY_MICRO_USD',
];

// The limits in force. In mock mode only, LIMIT_OVERRIDES (JSON such as
// {"GLOBAL_DAILY_CALLS":2}) replaces the named constants. Unknown names, values that
// are not non-negative integers, and unreadable JSON are ignored.
export function limitsFor(env) {
  const limits = Object.fromEntries(LIMIT_NAMES.map((name) => [name, C[name]]));
  if (env.MOCK_ANTHROPIC !== '1' || typeof env.LIMIT_OVERRIDES !== 'string' || !env.LIMIT_OVERRIDES) return limits;
  let overrides;
  try {
    overrides = JSON.parse(env.LIMIT_OVERRIDES);
  } catch {
    return limits;
  }
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return limits;
  for (const name of LIMIT_NAMES) {
    const v = overrides[name];
    if (Number.isInteger(v) && v >= 0) limits[name] = v;
  }
  return limits;
}

// ---- Time -------------------------------------------------------------------------

const pad = (n, w = 2) => String(n).padStart(w, '0');
const ymd = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
const ym = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}`;
const ymdhm = (d) => `${ymd(d)}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
export const unixSeconds = (d) => Math.floor(d.getTime() / 1000);

export const nextUtcMidnight = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));
export const firstOfNextMonth = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
const nextMinute = (d) => new Date(Math.floor(d.getTime() / 60000) * 60000 + 60000);
const secondsUntil = (from, to) => Math.max(1, Math.ceil((to.getTime() - from.getTime()) / 1000));
const isoSeconds = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

// ---- Visitor hash -----------------------------------------------------------------

// Local dev has no CF-Connecting-IP header; every local request shares this value.
export const LOCAL_IP = 'local-dev';

// First 24 hex characters of SHA-256 over IP_HASH_SALT, the UTC date and the IP,
// joined with "|". It changes daily, so it cannot follow a visitor across days.
export async function ipHash(env, ip, now) {
  const date = now.toISOString().slice(0, 10);
  const input = new TextEncoder().encode(`${env.IP_HASH_SALT}|${date}|${ip}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', input));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('').slice(0, C.IP_HASH_HEX_CHARS);
}

// ---- Counter keys -----------------------------------------------------------------

export function keysFor(hash, now) {
  return {
    burst: `ip:${hash}:min:${ymdhm(now)}`,
    trips: `ip:${hash}:trips:${ymd(now)}`,
    calls: `ip:${hash}:calls:${ymd(now)}`,
    globalCallsDay: `g:calls:d:${ymd(now)}`,
    globalUsdDay: `g:usd:d:${ymd(now)}`,
    globalCallsMonth: `g:calls:m:${ym(now)}`,
    globalUsdMonth: `g:usd:m:${ym(now)}`,
  };
}

const TTL = {
  burst: C.COUNTER_TTL_SECONDS.burst,
  trips: C.COUNTER_TTL_SECONDS.daily,
  calls: C.COUNTER_TTL_SECONDS.daily,
  globalCallsDay: C.COUNTER_TTL_SECONDS.daily,
  globalUsdDay: C.COUNTER_TTL_SECONDS.daily,
  globalCallsMonth: C.COUNTER_TTL_SECONDS.monthly,
  globalUsdMonth: C.COUNTER_TTL_SECONDS.monthly,
};

// The 4.8 increment statement.
const INCREMENT_SQL = 'INSERT INTO counters(key,value,expires_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value = value + ?2';

function increment(env, keys, name, by, now) {
  return env.DB.prepare(INCREMENT_SQL).bind(keys[name], by, unixSeconds(now) + TTL[name]);
}

async function readCounters(env, keys, names) {
  const wanted = names.map((n) => keys[n]);
  const sql = `SELECT key, value FROM counters WHERE key IN (${wanted.map((_, i) => `?${i + 1}`).join(',')})`;
  const { results } = await env.DB.prepare(sql).bind(...wanted).all();
  const byKey = new Map((results || []).map((r) => [r.key, r.value]));
  return Object.fromEntries(names.map((n) => [n, byKey.get(keys[n]) ?? 0]));
}

// ---- Decisions --------------------------------------------------------------------

// decide(values, stage, limits): a pure function. `values` holds the counter values
// before this call; missing ones count as 0. A call counter admits while it is below
// its limit, so the limit-th call is the last one. The dollar caps admit while spend
// is below the cap (agreed with Riley: the last call may overshoot by its own cost).
// Global caps are checked first, so a closed demo says so. Stage 'status' checks the
// global caps only.
export function decide(values, stage, limits) {
  const v = (name) => values[name] ?? 0;
  if (v('globalCallsMonth') >= limits.GLOBAL_MONTHLY_CALLS || v('globalUsdMonth') >= limits.GLOBAL_MONTHLY_MICRO_USD) {
    return { ok: false, code: 'demo_closed', scope: 'global_monthly' };
  }
  if (v('globalCallsDay') >= limits.GLOBAL_DAILY_CALLS || v('globalUsdDay') >= limits.GLOBAL_DAILY_MICRO_USD) {
    return { ok: false, code: 'demo_closed', scope: 'global_daily' };
  }
  if (stage === 'status') return { ok: true };
  if (stage === 'start' && v('trips') >= limits.VISITOR_TRIPS_PER_DAY) {
    return { ok: false, code: 'rate_limited', scope: 'visitor_trips' };
  }
  if (v('calls') >= limits.VISITOR_CALLS_PER_DAY) return { ok: false, code: 'rate_limited', scope: 'visitor_calls' };
  return { ok: true };
}

// Adds the timing a refused request carries: seconds to the next minute for a burst,
// to the next 00:00 UTC for a visitor's daily limit; reopensAt is the next UTC
// midnight for the daily cap and the first of next month for the monthly cap.
export function withTiming(decision, now) {
  switch (decision.scope) {
    case 'burst':
      return { ...decision, retryAfterSeconds: secondsUntil(now, nextMinute(now)) };
    case 'visitor_trips':
    case 'visitor_calls':
      return { ...decision, retryAfterSeconds: secondsUntil(now, nextUtcMidnight(now)) };
    case 'global_daily':
      return { ...decision, reopensAt: isoSeconds(nextUtcMidnight(now)) };
    case 'global_monthly':
      return { ...decision, reopensAt: isoSeconds(firstOfNextMonth(now)) };
    default:
      return decision;
  }
}

// ---- Steps the router calls ---------------------------------------------------------

// countBurst(env, hash, now): counts every POST this minute, including rejected ones,
// and rejects above the limit.
export async function countBurst(env, hash, now, limits = limitsFor(env)) {
  const keys = keysFor(hash, now);
  const row = await env.DB.prepare(`${INCREMENT_SQL} RETURNING value`)
    .bind(keys.burst, 1, unixSeconds(now) + TTL.burst)
    .first();
  if ((row?.value ?? 0) > limits.VISITOR_BURST_PER_MINUTE) {
    return withTiming({ ok: false, code: 'rate_limited', scope: 'burst' }, now);
  }
  return { ok: true };
}

// admit(env, hash, stage, now): reads the counters in one query, decides, and on
// success writes the call increments in one DB.batch(). Spend is added by settle.
export async function admit(env, hash, stage, now, limits = limitsFor(env)) {
  const keys = keysFor(hash, now);
  const names = ['calls', 'globalCallsDay', 'globalUsdDay', 'globalCallsMonth', 'globalUsdMonth'];
  if (stage === 'start') names.unshift('trips');
  const values = await readCounters(env, keys, names);
  const decision = decide(values, stage, limits);
  if (!decision.ok) return withTiming(decision, now);

  const writes = ['calls', 'globalCallsDay', 'globalCallsMonth'];
  if (stage === 'start') writes.unshift('trips');
  await env.DB.batch(writes.map((name) => increment(env, keys, name, 1, now)));
  return { ok: true };
}

// Whole micro-dollars for a call. Prices are US$ per million tokens, so a price is
// also micro-dollars per token; it is scaled to an integer first so that, for
// example, 3,050 tokens at 0.10 is exactly 305 and not 305.00000000000006.
export function costMicroUsd(model, usage) {
  const price = C.PRICES[model];
  if (!price) throw new Error('unpriced model');
  const scale = 1e6;
  const perMillionIn = Math.round(price.in * scale);
  const perMillionOut = Math.round(price.out * scale);
  const total = usage.input_tokens * perMillionIn + usage.output_tokens * perMillionOut;
  return Math.ceil(total / scale);
}

// settle(env, record, now): adds the actual cost to both dollar counters and inserts
// one usage_log row. record is { stage, model, usage, duration_ms, outcome }. The row
// holds token counts and timing only: no trip content and no IP data.
export async function settle(env, record, now) {
  const keys = keysFor('', now); // only the global keys are used here
  const cost = costMicroUsd(record.model, record.usage);
  const statements = [];
  if (cost > 0) {
    statements.push(increment(env, keys, 'globalUsdDay', cost, now));
    statements.push(increment(env, keys, 'globalUsdMonth', cost, now));
  }
  statements.push(env.DB.prepare(
    'INSERT INTO usage_log (ts, stage, model, input_tokens, output_tokens, cost_micro_usd, duration_ms, outcome) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)',
  ).bind(
    unixSeconds(now),
    record.stage,
    record.model,
    record.usage.input_tokens,
    record.usage.output_tokens,
    cost,
    Math.max(0, Math.round(record.duration_ms)),
    record.outcome,
  ));
  await env.DB.batch(statements);
  return cost;
}

// Deletes expired counters and usage_log rows older than 90 days. /start runs it
// inside ctx.waitUntil.
export async function cleanup(env, now) {
  const t = unixSeconds(now);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM counters WHERE expires_at < ?1').bind(t),
    env.DB.prepare('DELETE FROM usage_log WHERE ts < ?1').bind(t - C.USAGE_LOG_RETENTION_DAYS * 86400),
  ]);
}

// For GET /api/status: { open, reason, reopensAt } from DEMO_ENABLED and the global
// counters. reason is null, 'paused', 'daily_cap' or 'monthly_cap'.
export async function demoStatus(env, now, limits = limitsFor(env)) {
  if (env.DEMO_ENABLED === '0') return { open: false, reason: 'paused', reopensAt: null };
  const keys = keysFor('', now);
  const values = await readCounters(env, keys, ['globalCallsDay', 'globalUsdDay', 'globalCallsMonth', 'globalUsdMonth']);
  const decision = withTiming(decide(values, 'status', limits), now);
  if (decision.ok) return { open: true, reason: null, reopensAt: null };
  return {
    open: false,
    reason: decision.scope === 'global_monthly' ? 'monthly_cap' : 'daily_cap',
    reopensAt: decision.reopensAt,
  };
}

// The usage_log outcome for a model call (SPEC.md 4.8). An upstream 4xx returned as
// internal_error logs upstream_error.
export function outcomeOf(kind, shaped) {
  if (kind === 'ok') {
    if (!shaped.ok) return shaped.outcome;
    return shaped.value.type === 'declined' ? 'declined' : 'ok';
  }
  if (kind === 'internal_error') return 'upstream_error';
  return kind; // refusal, truncated, invalid_json, demo_closed, upstream_busy, upstream_error
}
