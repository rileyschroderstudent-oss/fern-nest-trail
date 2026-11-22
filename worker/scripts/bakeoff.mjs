#!/usr/bin/env node
// Bake-off (SPEC.md Task 13). Runs each brief in briefs.json through the questions
// call, answers every question with its first option, then runs the plan call, using
// the Worker's own request builder, prompt, schemas, message builder and
// post-validation. Calls go straight to the Claude API: they count against the
// Console limit but not the Worker's counters.
//
//   node worker/scripts/bakeoff.mjs --model claude-haiku-5-5 --dry-run   no network call
//   node worker/scripts/bakeoff.mjs --model claude-haiku-5-5             prints the estimate, then stops
//   node worker/scripts/bakeoff.mjs --model claude-haiku-5-5 --yes       makes the calls
//
// The API key is read from the ANTHROPIC_API_KEY environment variable only. Results
// go to worker/scripts/out/<model>/<n>.json (gitignored).
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { callModel, buildRequestBody } from '../src/anthropic.js';
import { buildMessage } from '../src/messages.js';
import { shapeQuestions, shapePlan } from '../src/postvalidate.js';
import { validateBrief } from '../src/validate.js';
import { costMicroUsd } from '../src/limits.js';
import { PRICES, MODEL_SETTINGS, MOCK_USAGE } from '../src/config.js';
import { QUESTIONS_FIXTURE } from '../src/fixtures/questions.js';
import { TRAIL_SYSTEM_PROMPT } from '../src/prompts/trail.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.resolve(HERE, '..');

// ---- Arguments ----------------------------------------------------------------------

function parseArgs(argv) {
  const args = { model: null, dryRun: false, yes: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--model') args.model = argv[++i] ?? null;
    else if (a.startsWith('--model=')) args.model = a.slice(8);
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--yes') args.yes = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

const USAGE_TEXT = 'Usage: node worker/scripts/bakeoff.mjs --model <id> [--dry-run | --yes]';

// ---- Inputs ---------------------------------------------------------------------------

// The anthropic-version header comes from wrangler.jsonc, as the Worker's does.
function anthropicVersion() {
  const text = readFileSync(path.join(WORKER, 'wrangler.jsonc'), 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  return JSON.parse(text).vars.ANTHROPIC_VERSION;
}

function loadBriefs(now) {
  const { briefs } = JSON.parse(readFileSync(path.join(HERE, 'briefs.json'), 'utf8'));
  return briefs.map((raw, i) => {
    const r = validateBrief(raw, now);
    if (!r.ok) throw new Error(`briefs.json brief ${i + 1} is invalid: ${JSON.stringify(r.fields)}`);
    return r.value;
  });
}

// ---- Cost estimate -----------------------------------------------------------------------

// Typical: the spec's per-call token estimates (the same figures mock mode reports).
// Ceiling: the same input estimate with every call using its full max_tokens.
function estimate(model, briefCount) {
  const stages = ['start', 'plan'];
  const typical = stages.reduce((sum, s) => sum + costMicroUsd(model, MOCK_USAGE[s]), 0) * briefCount;
  const ceiling = stages.reduce((sum, s) => sum + costMicroUsd(model, {
    input_tokens: MOCK_USAGE[s].input_tokens,
    output_tokens: MODEL_SETTINGS[s].max_tokens,
  }), 0) * briefCount;
  return { calls: stages.length * briefCount, typical, ceiling };
}

const usd = (micro) => `US$${(micro / 1e6).toFixed(4)}`;

// ---- Requests -------------------------------------------------------------------------

// Prints a request without the system prompt text and schema, which are the same for
// every request and are shown once.
function describeRequest(n, stage, env, message, note = '') {
  const body = buildRequestBody(env, stage, message);
  const schema = stage === 'start' ? 'QUESTIONS_SCHEMA' : 'PLAN_SCHEMA';
  console.log(`\n--- Request ${n}: brief ${Math.ceil(n / 2)}, ${stage === 'start' ? 'questions' : 'plan'} call${note}`);
  console.log(`model ${body.model} · max_tokens ${body.max_tokens} · effort ${body.output_config.effort} · format json_schema (${schema})`);
  console.log(message);
}

const firstOptionAnswers = (questions) => questions.map((q) => ({ questionId: q.id, optionId: q.options[0].id }));

// Calls the model and keeps the raw stop reason for the table.
async function call(env, stage, message) {
  let raw = null;
  const fetchImpl = async (url, init) => {
    const res = await fetch(url, init);
    try {
      raw = await res.clone().json();
    } catch {
      raw = null;
    }
    return res;
  };
  const started = Date.now();
  const result = await callModel(env, stage, message, fetchImpl);
  return {
    kind: result.kind,
    stop_reason: raw?.stop_reason ?? null,
    usage: result.usage,
    cost_micro_usd: costMicroUsd(env.MODEL, result.usage),
    seconds: (Date.now() - started) / 1000,
    output: result.json,
  };
}

function printTable(rows) {
  const head = ['#', 'brief', 'stage', 'in', 'out', 'cost', 's', 'stop', 'result', 'warnings'];
  const lines = rows.map((r) => [
    r.n, r.brief, r.stage, r.in, r.out, usd(r.cost), r.seconds.toFixed(1), r.stop ?? '-', r.result, r.warnings || '-',
  ].map(String));
  const widths = head.map((h, i) => Math.max(h.length, ...lines.map((l) => l[i].length)));
  const fmt = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
  console.log(`\n${fmt(head)}\n${widths.map((w) => '-'.repeat(w)).join('  ')}`);
  for (const l of lines) console.log(fmt(l));
}

// ---- Main -------------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.model) {
    console.log(USAGE_TEXT);
    return args.help ? 0 : 2;
  }
  if (!Object.hasOwn(PRICES, args.model)) {
    console.error(`No price for model ${args.model} in config.js, so its cost cannot be estimated or capped. Known: ${Object.keys(PRICES).join(', ')}`);
    return 2;
  }

  const now = new Date();
  const briefs = loadBriefs(now);
  const env = {
    MOCK_ANTHROPIC: '0',
    MODEL: args.model,
    ANTHROPIC_VERSION: anthropicVersion(),
    ANTHROPIC_API_KEY: args.dryRun ? '' : (process.env.ANTHROPIC_API_KEY || ''),
  };
  const est = estimate(args.model, briefs.length);

  console.log(`Bake-off: ${briefs.length} briefs, ${est.calls} calls on ${args.model}.`);
  console.log(`Estimated cost: about ${usd(est.typical)} (the spec's token estimates), at most ${usd(est.ceiling)} if every call uses its full max_tokens.`);
  console.log(`System prompt: ${TRAIL_SYSTEM_PROMPT.length} characters, the same for every request. anthropic-version: ${env.ANTHROPIC_VERSION}.`);

  if (args.dryRun) {
    // Belt and braces: a dry run can never reach the network.
    globalThis.fetch = () => { throw new Error('dry run: no network calls'); };
    const placeholder = shapeQuestions(structuredClone(QUESTIONS_FIXTURE)).value.questions;
    let n = 0;
    for (const brief of briefs) {
      describeRequest(++n, 'start', env, buildMessage('start', { brief }, now));
      describeRequest(++n, 'plan', env, buildMessage('plan', { brief, questions: placeholder, answers: firstOptionAnswers(placeholder) }, now),
        ' (the real interview depends on the questions call; the mock questions stand in here)');
    }
    console.log(`\nDry run: ${n} planned requests printed. No network call was made.`);
    return 0;
  }

  if (!args.yes) {
    console.log(`\nNot run. Re-run with --yes to make these ${est.calls} calls, or --dry-run to see the requests.`);
    return 1;
  }
  if (!env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY is not set in the environment. Nothing was sent.');
    return 1;
  }

  const outDir = path.join(HERE, 'out', args.model);
  mkdirSync(outDir, { recursive: true });
  const rows = [];

  for (const [i, brief] of briefs.entries()) {
    const n = i + 1;
    const record = { brief, model: args.model, ran_at: new Date().toISOString() };

    const qMessage = buildMessage('start', { brief }, now);
    const q = await call(env, 'start', qMessage);
    const qShaped = q.kind === 'ok' ? shapeQuestions(q.output) : null;
    record.questions = { message: qMessage, ...q, shaped: qShaped };
    rows.push({
      n, brief: brief.destination, stage: 'questions', in: q.usage.input_tokens, out: q.usage.output_tokens,
      cost: q.cost_micro_usd, seconds: q.seconds, stop: q.stop_reason,
      result: qShaped ? (qShaped.ok ? (qShaped.value.type || 'ok') : qShaped.outcome) : q.kind, warnings: '',
    });

    const questions = qShaped?.ok && !qShaped.value.type ? qShaped.value.questions : null;
    if (questions) {
      const answers = firstOptionAnswers(questions);
      const pMessage = buildMessage('plan', { brief, questions, answers }, now);
      const p = await call(env, 'plan', pMessage);
      const pShaped = p.kind === 'ok' ? shapePlan(p.output, brief) : null;
      record.plan = { message: pMessage, answers, ...p, shaped: pShaped };
      rows.push({
        n, brief: brief.destination, stage: 'plan', in: p.usage.input_tokens, out: p.usage.output_tokens,
        cost: p.cost_micro_usd, seconds: p.seconds, stop: p.stop_reason,
        result: pShaped ? (pShaped.ok ? (pShaped.value.type || 'ok') : pShaped.outcome) : p.kind,
        warnings: pShaped?.ok ? pShaped.warnings.join(',') : '',
      });
    } else {
      record.plan = null; // no usable questions, so no plan call
    }

    writeFileSync(path.join(outDir, `${n}.json`), `${JSON.stringify(record, null, 2)}\n`);
  }

  printTable(rows);
  const total = rows.reduce((s, r) => s + r.cost, 0);
  console.log(`\nTotal: ${rows.length} calls, ${usd(total)}. Results in ${path.relative(process.cwd(), outDir)}. Score them with scripts/rubric.md.`);
  return 0;
}

main().then((code) => { process.exitCode = code; }, (err) => {
  // Never print the key, a request or a response here.
  console.error(`Bake-off stopped: ${err.message}`);
  process.exitCode = 1;
});
