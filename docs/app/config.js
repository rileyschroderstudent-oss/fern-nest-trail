// The two public values the page needs (SPEC.md 4.5): the Worker's base URL and the
// Turnstile site key. Local values are used when the page is served from localhost.
// Nothing secret belongs in this file: everything here is visible to every visitor.

const LOCAL = {
  apiBase: 'http://localhost:8787',
  // Cloudflare's always-pass test site key.
  turnstileSiteKey: '1x00000000000000000000AA',
};

// Riley fills these in during deployment (SPEC.md section 7, steps C and F).
const PRODUCTION = {
  apiBase: 'https://fnt-api.YOUR-SUBDOMAIN.workers.dev',
  turnstileSiteKey: 'YOUR-TURNSTILE-SITE-KEY',
};

export const CONFIG = location.hostname === 'localhost' ? LOCAL : PRODUCTION;
