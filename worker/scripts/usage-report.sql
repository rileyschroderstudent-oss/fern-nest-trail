-- Usage report (SPEC.md Task 13). Run from worker/:
--   npx wrangler d1 execute fnt-usage --remote --file scripts/usage-report.sql
-- Costs are whole micro-dollars (1,000,000 = US$1). Reads usage_log only: token
-- counts, cost, duration and outcome. No trip content and no IP data exist to read.

-- Per stage: the count, and the average, minimum and maximum of input tokens,
-- output tokens, cost and duration.
SELECT
  stage,
  COUNT(*)                     AS calls,
  ROUND(AVG(input_tokens), 1)  AS avg_input_tokens,
  MIN(input_tokens)            AS min_input_tokens,
  MAX(input_tokens)            AS max_input_tokens,
  ROUND(AVG(output_tokens), 1) AS avg_output_tokens,
  MIN(output_tokens)           AS min_output_tokens,
  MAX(output_tokens)           AS max_output_tokens,
  ROUND(AVG(cost_micro_usd), 1) AS avg_cost_micro_usd,
  MIN(cost_micro_usd)          AS min_cost_micro_usd,
  MAX(cost_micro_usd)          AS max_cost_micro_usd,
  ROUND(AVG(duration_ms), 1)   AS avg_duration_ms,
  MIN(duration_ms)             AS min_duration_ms,
  MAX(duration_ms)             AS max_duration_ms
FROM usage_log
GROUP BY stage
ORDER BY stage;

-- Total cost per UTC day.
SELECT
  date(ts, 'unixepoch')                  AS day,
  COUNT(*)                               AS calls,
  SUM(cost_micro_usd)                    AS cost_micro_usd,
  ROUND(SUM(cost_micro_usd) / 1000000.0, 6) AS cost_usd
FROM usage_log
GROUP BY day
ORDER BY day;
