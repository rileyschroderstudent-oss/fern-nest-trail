# Deploying the Worker

Copy-paste runbook for putting WEB TRAIL live. It mirrors SPEC.md section 7, steps C to G. Run every command from the `worker/` folder unless it says otherwise. Commands are for PowerShell on Windows; they also work in bash.

No secret value belongs in this file, in a commit, in `docs/app/config.js` or in a chat. Each `secret put` command prompts for its value.

## Before you start

- A free Cloudflare account on the **Workers Free** plan. Do not upgrade to Workers Paid.
- A Claude Console workspace named `fern-nest-trail` with its own API key, `fnt-worker`, a US$6 monthly spend limit, prepaid credits and auto-reload off (SPEC.md 7.D).
- `npm install` has been run in `worker/`, and `npm test` passes.

## 1. Log in and create the database

```text
cd worker
npx wrangler login
npx wrangler d1 create fnt-usage
```

Copy the `database_id` that `d1 create` prints into `wrangler.jsonc`, replacing the all-zero placeholder under `d1_databases`, then commit that change.

## 2. Apply the migration remotely

```text
npx wrangler d1 migrations apply fnt-usage --remote
```

This creates the `counters` and `usage_log` tables from `migrations/0001_init.sql`.

## 3. Create the Turnstile widget

In the Cloudflare dashboard, create a Turnstile widget in **Managed** mode for the hostname `rileyschroderstudent-oss.github.io`. Keep its **site key** for step 7 and its **secret key** for step 4.

## 4. Set the four secrets

Generate two random values, one for `SESSION_SECRET` and one for `IP_HASH_SALT`, by running this twice:

```text
node -e "console.log(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex'))"
```

Then set each secret. Each command prompts for the value; paste it there, never on the command line:

```text
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put TURNSTILE_SECRET_KEY
npx wrangler secret put SESSION_SECRET
npx wrangler secret put IP_HASH_SALT
```

`SESSION_SECRET` must be at least 32 characters, or every model route returns `internal_error`.

## 5. Check the production vars

In `wrangler.jsonc`, under `vars`, confirm:

| Var | Value |
| --- | --- |
| `MOCK_ANTHROPIC` | `"0"` |
| `DEMO_ENABLED` | `"1"` |
| `MODEL` | `"claude-haiku-5-5"` |
| `ANTHROPIC_VERSION` | `"2023-06-01"` |
| `ALLOWED_ORIGINS` | `"https://rileyschroderstudent-oss.github.io"`, exactly, with no trailing slash |

Do not add `LIMIT_OVERRIDES` in production. It is ignored unless `MOCK_ANTHROPIC` is `"1"`.

`worker/.dev.vars` is for local development only and is never uploaded.

## 6. Deploy

```text
npx wrangler deploy --dry-run
npx wrangler deploy
```

The dry run compiles and checks without uploading. The real deploy prints the Worker's URL, `https://fnt-api.<your-subdomain>.workers.dev`. Note it.

## 7. Point the page at the Worker

In `docs/app/config.js`, set the `PRODUCTION` values:

- `apiBase`: the Worker URL from step 6, with no trailing slash.
- `turnstileSiteKey`: the site key from step 3.

Any change in `docs/app` needs a version bump, so in the same commit:

- set `APP_VERSION` in `docs/app/index.html` to a new value, and
- set `MODULE_VERSION` in `docs/app/app.js` to the same value.

Then check:

```text
node --test docs/app/loader.test.mjs
```

Run that from the repo root; it fails if the two versions differ. Merge `tier3-app` into `main` and push. GitHub Pages updates within a few minutes.

## 8. Verify

```text
curl.exe -s https://fnt-api.<your-subdomain>.workers.dev/api/status
```

It should show `"open": true` and `"mock": false`.

```text
curl.exe -s -o NUL -w "%{http_code}\n" -X POST -H "Origin: https://evil.example" -H "Content-Type: application/json" -d "{}" https://fnt-api.<your-subdomain>.workers.dev/api/trail/start
```

That should print `403`. In bash, use `curl` and `/dev/null` in place of `curl.exe` and `NUL`.

Then run the live tests in SPEC.md 7.G: one full trip, the eight guardrail briefs in `scripts/guardrail-briefs.json`, a fourth trip to see the daily limit, the kill switch, and the page-source and Network-tab check that the key appears nowhere.

## Pause the demo

Set `DEMO_ENABLED` to `"0"` in `wrangler.jsonc`, then:

```text
npx wrangler deploy
```

Model routes return 503 `demo_closed` and `/api/status` shows `"reason": "paused"`. To reopen, set it back to `"1"` and deploy again.

A var changed only in the Cloudflare dashboard is overwritten by the next `wrangler deploy`. Change `wrangler.jsonc` too, or the kill switch silently resets.

## Roll back

```text
npx wrangler deployments list
npx wrangler rollback
```

`rollback` with no argument goes back to the previous version; pass a version ID from `deployments list` to choose one. The database is not rolled back: its tables and rows stay as they are. If the page changed too, revert the `docs/app` commit on `main` and push.

## Rotate the API key

If the key may have leaked:

1. In the Claude Console, delete the `fnt-worker` key in the `fern-nest-trail` workspace and create a new one.
2. Run this and paste the new key at the prompt:

```text
npx wrangler secret put ANTHROPIC_API_KEY
```

The new secret takes effect at once; no deploy is needed.

## Change a cap

Every limit, price and model setting lives in `worker/src/config.js`, for example `GLOBAL_DAILY_MICRO_USD`, `GLOBAL_MONTHLY_MICRO_USD`, `GLOBAL_DAILY_CALLS`, `GLOBAL_MONTHLY_CALLS`, `VISITOR_TRIPS_PER_DAY` and `VISITOR_CALLS_PER_DAY`. Money is in whole micro-dollars: 1,000,000 is US$1. Edit the value, then:

```text
npm test
npx wrangler deploy
```

Keep the Console spend limit above the Worker's monthly cap. To switch model, set `MODEL` in `wrangler.jsonc` to another model in the `PRICES` table, `claude-sonnet-5-5` for example, and deploy. A model with no price makes every model route return `internal_error`, so it can never run uncapped.

## Read the usage report

```text
npx wrangler d1 execute fnt-usage --remote --file scripts/usage-report.sql
```

It prints, per stage, the call count and the average, minimum and maximum of tokens, cost and duration, then total cost per UTC day. Compare the total with the Console's usage page; they should agree within about 10%.

To see why calls fail, look at the outcomes:

```text
npx wrangler d1 execute fnt-usage --remote --command "SELECT outcome, COUNT(*) AS calls FROM usage_log GROUP BY outcome"
```

- `truncated` means raise `max_tokens` in `MODEL_SETTINGS` in `config.js`.
- `banned_phrase` means the prompt needs tightening.

## If something looks wrong

| If you see | Look at |
| --- | --- |
| "Demo closed" when it should be open | `/api/status` for the reason, then the `counters` table, then the Console's spend limit and balance |
| Every call returns `bad_model_output` | The `outcome` column in `usage_log` |
| `forbidden_origin` on the live site | `ALLOWED_ORIGINS` must match the origin exactly, with no trailing slash |
| `challenge_failed` for everyone | The Turnstile widget's hostname list, and that the site key and secret belong to the same widget |
| An error about the API version on the first call | Set `ANTHROPIC_VERSION` in `wrangler.jsonc` to the value in the current API reference, then deploy |
