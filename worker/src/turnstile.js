// Cloudflare Turnstile server-side check (SPEC.md Task 9). Runs on /start only,
// before admit, so a failed check uses none of the visitor's daily allowance.
import { TURNSTILE_VERIFY_URL, TURNSTILE_TIMEOUT_MS } from './config.js';

const allowedHostnames = (env) => String(env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((origin) => {
    try {
      return new URL(origin).hostname;
    } catch {
      return null;
    }
  })
  .filter(Boolean);

// The default calls the global fetch at call time (unbound, as Workers require).
const defaultFetch = (...args) => fetch(...args);

// verifyTurnstile(env, token, ip, fetchImpl): POSTs secret, response and remoteip to
// siteverify and returns true only when success is true. Outside mock mode the
// returned hostname must also belong to an allowed origin. Every failure, including
// a network error, a timeout or an unreadable reply, returns false. remoteip is left
// out when the IP is unknown (local dev).
export async function verifyTurnstile(env, token, ip, fetchImpl = defaultFetch) {
  if (typeof token !== 'string' || token.length === 0) return false;
  const form = new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: token });
  if (typeof ip === 'string' && ip) form.set('remoteip', ip);

  let data;
  try {
    const res = await fetchImpl(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      signal: AbortSignal.timeout(TURNSTILE_TIMEOUT_MS),
    });
    if (!res.ok) return false;
    data = await res.json();
  } catch {
    return false;
  }

  if (!data || data.success !== true) return false;
  if (env.MOCK_ANTHROPIC === '1') return true;
  return typeof data.hostname === 'string' && allowedHostnames(env).includes(data.hostname);
}
