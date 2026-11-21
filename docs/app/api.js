// Fetch wrapper and error mapping. Every error the page shows is fixed text from
// this file (SPEC.md 4.4); the server's own message text is never displayed.
import { CONFIG } from './config.js';

// Give up waiting after this long (SPEC.md Task 3).
export const REQUEST_TIMEOUT_MS = 120000;

export const ERROR_TEXT = {
  invalid_input: 'Some fields need fixing. Check the messages beside them.',
  forbidden_origin: 'Something went wrong. Reload the page and try again.',
  challenge_failed: "Couldn't verify your browser. Reload and try again.",
  invalid_session: "This trip can't be continued. Start again.",
  session_expired: 'This trip expired. Start again.',
  revisions_exhausted: "You've used both revisions.",
  rate_limited: 'Slow down. Try again in a minute.',
  demo_closed: 'The demo has hit its budget and is closed for now.',
  upstream_busy: 'Claude is busy. Try again in a minute.',
  upstream_error: 'Claude is busy. Try again in a minute.',
  bad_model_output: 'That plan came back malformed. Try again.',
  internal_error: 'Something went wrong. Try again later.',
  not_found: 'Something went wrong. Try again later.',
  method_not_allowed: 'Something went wrong. Try again later.',
  network: "Can't reach the server. Check your connection.",
  timeout: 'That took too long. Try again.',
};

// Fixed text for each decline reason. The model's own text is never shown.
export const DECLINE_TEXT = {
  not_travel: 'This app only plans trips. Change the brief so it describes a trip, then try again.',
  unclear_destination: "We couldn't tell which place you meant. Try the name of a country, region or city.",
  unsafe_or_abusive: "This brief can't be planned here.",
  other: "This trip couldn't be planned. Try changing the brief.",
};

export function errorText(code) {
  return ERROR_TEXT[code] || ERROR_TEXT.internal_error;
}

// Returns { ok: true, data } or { ok: false, code, error }, where error is the
// server's error envelope when there was one. Never throws.
async function request(method, path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(CONFIG.apiBase + path, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (res.ok && data && typeof data === 'object') return { ok: true, data };
    const error = data && typeof data.error === 'object' && data.error ? data.error : null;
    const code = error && typeof error.code === 'string' ? error.code : 'internal_error';
    return { ok: false, code, error };
  } catch (err) {
    return { ok: false, code: err && err.name === 'AbortError' ? 'timeout' : 'network', error: null };
  } finally {
    clearTimeout(timer);
  }
}

export const getStatus = () => request('GET', '/api/status');
export const startTrip = (body) => request('POST', '/api/trail/start', body);
export const planTrip = (body) => request('POST', '/api/trail/plan', body);
