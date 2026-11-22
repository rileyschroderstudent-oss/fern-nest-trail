// Task 13 scripts: the bake-off CLI and the usage report. No network call is made:
// the CLI runs only with --dry-run, without --yes, or without a key.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createD1 } from './d1.js';
import { validateBrief } from '../src/validate.js';

const SCRIPT = fileURLToPath(new URL('../scripts/bakeoff.mjs', import.meta.url));
const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], {
  encoding: 'utf8',
  env: { ...process.env, ANTHROPIC_API_KEY: '' },
});

describe('bakeoff.mjs', () => {
  test('--dry-run prints twelve planned requests and an estimated cost', () => {
    const r = run('--model', 'claude-haiku-5-5', '--dry-run');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.match(/^--- Request \d+:/gm).length, 12);
    assert.match(r.stdout, /Estimated cost: about US\$0\.0202/);
    assert.match(r.stdout, /No network call was made\./);
    // The estimate comes first.
    assert.ok(r.stdout.indexOf('Estimated cost') < r.stdout.indexOf('--- Request 1:'));
  });

  test('without --yes it prints the estimate and exits with a message', () => {
    const r = run('--model', 'claude-haiku-5-5');
    assert.equal(r.status, 1);
    assert.match(r.stdout, /Estimated cost/);
    assert.match(r.stdout, /Re-run with --yes/);
    assert.doesNotMatch(r.stdout, /--- Request/);
  });

  test('with --yes but no key it sends nothing', () => {
    const r = run('--model', 'claude-haiku-5-5', '--yes');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /ANTHROPIC_API_KEY is not set/);
  });

  test('refuses a model with no price, and asks for --model', () => {
    const unpriced = run('--model', 'claude-unknown', '--dry-run');
    assert.equal(unpriced.status, 2);
    assert.match(unpriced.stderr, /No price for model/);
    assert.equal(run('--dry-run').status, 2);
  });

  test('prices Sonnet 5.5 from config.js', () => {
    const r = run('--model', 'claude-sonnet-5-5', '--dry-run');
    assert.equal(r.status, 0);
    // 6 x (questions 3,050 in + 800 out = 14,100, plan 4,150 + 4,500 = 53,300 micro-dollars)
    // at US$2 and US$10 per million tokens.
    assert.match(r.stdout, /about US\$0\.4044/);
  });
});

describe('briefs.json and guardrail-briefs.json', () => {
  const now = new Date();

  test('the six bake-off briefs are valid briefs', () => {
    const { briefs } = JSON.parse(readFileSync(new URL('../scripts/briefs.json', import.meta.url), 'utf8'));
    assert.equal(briefs.length, 6);
    for (const b of briefs) assert.equal(validateBrief(b, now).ok, true, b.destination);
  });

  test('the eight guardrail briefs are valid briefs once defaults are applied', () => {
    const g = JSON.parse(readFileSync(new URL('../scripts/guardrail-briefs.json', import.meta.url), 'utf8'));
    assert.deepEqual(g.briefs.map((b) => b.n), [1, 2, 3, 4, 5, 6, 7, 8]);
    for (const b of g.briefs) {
      assert.equal(validateBrief({ ...g.defaults, ...b.brief }, now).ok, true, `guardrail ${b.n}`);
      assert.ok(b.expected.length > 0);
    }
  });
});

describe('usage-report.sql', () => {
  test('reports count and average, minimum and maximum per stage, and cost per day', () => {
    const db = createD1();
    const day1 = Date.UTC(2026, 10, 21, 10) / 1000;
    const day2 = Date.UTC(2026, 10, 22, 10) / 1000;
    const row = (ts, stage, i, o, cost, ms) => db.rows(
      "INSERT INTO usage_log (ts, stage, model, input_tokens, output_tokens, cost_micro_usd, duration_ms, outcome) VALUES (?, ?, 'claude-haiku-5-5', ?, ?, ?, ?, 'ok') RETURNING id",
      ts, stage, i, o, cost, ms,
    );
    row(day1, 'start', 3000, 800, 700, 2000);
    row(day1, 'start', 3100, 900, 760, 4000);
    row(day1, 'plan', 4150, 4500, 2665, 30000);
    row(day2, 'plan', 4000, 4000, 2400, 20000);

    const sql = readFileSync(new URL('../scripts/usage-report.sql', import.meta.url), 'utf8');
    const statements = sql.split(';').map((s) => s.replace(/--.*$/gm, '').trim()).filter(Boolean);
    assert.equal(statements.length, 2);

    const [perStage, perDay] = statements.map((s) => db.rows(s));
    assert.deepEqual(perStage.map((r) => [r.stage, r.calls, r.avg_input_tokens, r.min_input_tokens, r.max_output_tokens, r.avg_cost_micro_usd, r.max_duration_ms]), [
      ['plan', 2, 4075, 4000, 4500, 2532.5, 30000],
      ['start', 2, 3050, 3000, 900, 730, 4000],
    ]);
    assert.deepEqual(perDay, [
      { day: '2026-11-21', calls: 3, cost_micro_usd: 4125, cost_usd: 0.004125 },
      { day: '2026-11-22', calls: 1, cost_micro_usd: 2400, cost_usd: 0.0024 },
    ]);
  });
});
