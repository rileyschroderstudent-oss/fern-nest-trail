# Architecture: WEB TRAIL in a browser

An estimate-only web app that runs WEB TRAIL through the Claude API. A static page on GitHub Pages talks to one Cloudflare Worker, which holds the API key and is the only thing that calls Claude. Version one ships WEB TRAIL only; WEB FERN and WEB NEST are not in the app.

## Request path

1. The browser sends a JSON POST to the Worker.
2. The Worker matches the route and answers CORS preflights.
3. It rejects any Origin not in `ALLOWED_ORIGINS` (403).
4. It checks the `DEMO_ENABLED` kill switch (503 if off).
5. It counts the visitor's POSTs this minute and rejects over 10 (429).
6. It checks the body size, parses the JSON and validates every field (400).
7. On `/start` it verifies the Cloudflare Turnstile token (403). On `/plan` and `/revise` it verifies the signed session token's signature, expiry and stage (401, 410).
8. It checks the visitor's daily limits and the global daily and monthly caps (429 or 503).
9. It builds one user message from validated data and calls the Claude API, or canned fixtures in mock mode.
10. It checks the stop reason, parses the JSON and runs the post-validation rules, including a banned-phrase check for "live" or "guaranteed" prices.
11. It signs a new session token and responds.
12. After responding, it adds the call's actual cost to the spend counters and writes one usage-log row.
13. The browser renders the plan and computes totals, contingency and the fit verdict with `docs/app/budget.js`.

## Decisions

| Decision | Why |
| --- | --- |
| WEB TRAIL first | FERN and NEST only earn their keep with live prices. TRAIL's value is structure: an interview, an itinerary, an itemised budget and a fit check, which still works on estimates. |
| Estimate-only | No flight or hotel data and no search. Every figure is labelled as an estimate, and the page adds a fixed banner the model cannot drop. |
| A Worker in front of the API | The site is static, so anything in it is public. The key is a Worker secret and never reaches the browser. |
| `claude-haiku-5-5`, one setting to change | US$0.10 in and US$0.50 out per million tokens, against US$2 and US$10 for Sonnet 5.5. Sonnet is the fallback only if Haiku fails a six-brief bake-off. Result: [NEEDS: bake-off scores for both models, with date]. |
| JSON against a schema | The model fills two fixed schemas, so the app decides what is shown, including the disclaimers. |
| The maths in code | The model gives line items with a low and a high unit cost. `budget.js` adds them up, applies contingency and compares the result with the budget. |
| A fixed three-step flow | Brief, then three or four multiple-choice questions, then the plan, with up to two revisions. No open chat box, so cost per visitor is capped and misuse has less room. |
| No server-side sessions | The browser carries a session token holding the validated brief, questions and answers, signed with HMAC-SHA256. Each stage is a fresh single-turn request. No trip content is stored. |
| Caps in dollars, not only request counts | Every call is priced from the token counts the API returns, so a change of model or prompt length cannot raise spend past the caps. |
| D1 for counters | Updates to one row are applied in order. A key-value store can be up to a minute stale, which is wrong for a spending cap. |
| Bot check on the first step only | `/start` needs Turnstile. Later steps need the signed token from it. |
| No framework, no build step | Three screens in plain HTML, CSS and JavaScript modules. |
| Mock mode | `MOCK_ANTHROPIC=1` returns fixtures with no API key, so the whole flow can be built, tested and cloned for free. |
| Not optimised on purpose | No streaming (partial JSON cannot be rendered) and no prompt caching (the two calls use different schemas and effort levels). |

## Cost controls

| Layer | Limit | Enforced by |
| --- | --- | --- |
| Visitor burst | 10 POST requests a minute per IP | D1 counter |
| Visitor daily | 3 trips started and 12 model calls per IP per UTC day | D1 counter |
| Bot check | Turnstile on `/start` only | Cloudflare siteverify |
| Global daily | 120 model calls or US$0.35, whichever comes first | D1 counter |
| Global monthly | 1,500 model calls or US$4.50 | D1 counter |
| Kill switch | `DEMO_ENABLED` set to `0` | Worker variable |
| Console workspace limit | US$6 a month on a dedicated workspace | Anthropic |
| Prepaid credits | Auto-reload off | Anthropic billing |

Any one layer can fail and the next still holds. The IP limits can be dodged with many IPs and the Origin check only stops other websites' pages, so the global caps, the Console limit and the prepaid balance are what bound cost. Two requests at the same moment can pass a cap by at most their own cost.

Measured cost per run: [NEEDS: average from usage-report.sql, number of runs, date].

## Storage and privacy

One D1 database with two tables. `counters` holds per-minute, per-day and per-month counts. Visitor keys use the first 24 hex characters of a salted SHA-256 of the IP and the UTC date, so they change daily and cannot follow a visitor across days. Counters expire after two minutes, two days or 40 days. `usage_log` holds the stage, model, token counts, cost, duration and outcome of each call, for 90 days. Neither table holds trip content or an IP address. The visitor's text is sent to Anthropic to generate the plan, under Anthropic's own data policies.

## Not built in version one

- **TRAIL calling FERN and NEST** as a fixed pipeline in the Worker: one FERN call for the route, one NEST call per stop, then a TRAIL synthesis call.
- **Live data**, in rising order of cost: a daily exchange rate, Claude's web search tool for entry rules and seasonal facts, then flight and hotel price APIs. The caps and the cost model must be redone before any of these launches.

What was tested: [NEEDS: bake-off scores for six briefs, and the result of the eight guardrail briefs, with date].
