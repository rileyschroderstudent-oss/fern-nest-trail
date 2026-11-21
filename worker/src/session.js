// Session tokens (SPEC.md 4.8). A token is
//   base64url(payload JSON) + "." + base64url(HMAC-SHA256(payload bytes, SESSION_SECRET))
// built with Web Crypto and checked with crypto.subtle.verify. It is signed, not
// encrypted: it only holds the visitor's own brief, questions and answers.
import { SESSION_VERSION, SESSION_TTL_SECONDS, SESSION_SECRET_MIN_CHARS } from './config.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

// ---- base64url, no padding ------------------------------------------------------

export function base64urlEncode(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64urlDecode(text) {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) throw new Error('bad base64url');
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ---- Keys -------------------------------------------------------------------------

// True when SESSION_SECRET is long enough to use. The router returns internal_error
// before any model call when it is not.
export function hasUsableSecret(env) {
  return typeof env.SESSION_SECRET === 'string' && env.SESSION_SECRET.length >= SESSION_SECRET_MIN_CHARS;
}

function importKey(env) {
  if (!hasUsableSecret(env)) throw new Error('SESSION_SECRET missing or too short');
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(env.SESSION_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

function randomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// ---- Sign and verify ----------------------------------------------------------------

// Signs a payload object as-is. Most callers want issueSession instead.
export async function signPayload(env, payload) {
  const bytes = encoder.encode(JSON.stringify(payload));
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', await importKey(env), bytes));
  return `${base64urlEncode(bytes)}.${base64urlEncode(signature)}`;
}

// issueSession(env, fields, now): adds v, a fresh id, iat and exp to
// { stage, revs, brief, questions, answers } and signs it.
// Questions are stored without `why`, to keep the token small.
export function issueSession(env, { stage, revs = 0, brief, questions, answers = [] }, now) {
  const iat = Math.floor(now.getTime() / 1000);
  return signPayload(env, {
    v: SESSION_VERSION,
    id: randomId(),
    iat,
    exp: iat + SESSION_TTL_SECONDS,
    stage,
    revs,
    brief,
    questions: questions.map((q) => ({
      id: q.id,
      text: q.text,
      options: q.options.map((o) => ({ id: o.id, label: o.label })),
    })),
    answers,
  });
}

const invalid = () => ({ ok: false, code: 'invalid_session' });

// verifySession(env, token, { stage, now }): checks the signature first, then the
// payload's shape, the expiry and the stage. Returns { ok: true, payload } or
// { ok: false, code } with code 'invalid_session' or 'session_expired'.
// A token is expired once it is more than SESSION_TTL_SECONDS old.
export async function verifySession(env, token, { stage, now }) {
  if (typeof token !== 'string') return invalid();
  const parts = token.split('.');
  if (parts.length !== 2) return invalid();

  let payloadBytes;
  let signature;
  try {
    payloadBytes = base64urlDecode(parts[0]);
    signature = base64urlDecode(parts[1]);
  } catch {
    return invalid();
  }

  const key = await importKey(env);
  if (!(await crypto.subtle.verify('HMAC', key, signature, payloadBytes))) return invalid();

  let payload;
  try {
    payload = JSON.parse(decoder.decode(payloadBytes));
  } catch {
    return invalid();
  }
  if (!isPayload(payload)) return invalid();

  if (Math.floor(now.getTime() / 1000) > payload.exp) return { ok: false, code: 'session_expired' };
  if (payload.stage !== stage) return invalid();
  return { ok: true, payload };
}

function isPayload(p) {
  return p !== null && typeof p === 'object' && !Array.isArray(p)
    && p.v === SESSION_VERSION
    && typeof p.id === 'string'
    && Number.isInteger(p.iat) && Number.isInteger(p.exp)
    && typeof p.stage === 'string'
    && Number.isInteger(p.revs)
    && p.brief !== null && typeof p.brief === 'object'
    && Array.isArray(p.questions) && Array.isArray(p.answers);
}
