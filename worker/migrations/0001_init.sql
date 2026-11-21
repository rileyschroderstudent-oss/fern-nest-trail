-- SPEC.md 4.8. Counters and a token-usage log. No trip content and no IP data.
CREATE TABLE IF NOT EXISTS counters (
  key        TEXT PRIMARY KEY,
  value      INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS usage_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ts             INTEGER NOT NULL,
  stage          TEXT NOT NULL,
  model          TEXT NOT NULL,
  input_tokens   INTEGER NOT NULL,
  output_tokens  INTEGER NOT NULL,
  cost_micro_usd INTEGER NOT NULL,
  duration_ms    INTEGER NOT NULL,
  outcome        TEXT NOT NULL
);
