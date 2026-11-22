// Checks the loader in index.html: every local module the app imports must be in its
// MODULES list, or that module would load without ?v= and could come from an old
// cache. Run with: node --test docs/app/loader.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const dir = new URL('./', import.meta.url);
const html = readFileSync(new URL('index.html', dir), 'utf8');

const listed = JSON.parse(/var MODULES = (\[[^\]]*\]);/.exec(html)[1].replace(/'/g, '"'));

test('index.html sets APP_VERSION once', () => {
  assert.equal(html.match(/var APP_VERSION = '[^']+';/g)?.length, 1);
});

test('MODULE_VERSION in app.js equals APP_VERSION in index.html', () => {
  const pageVersion = /var APP_VERSION = '([^']+)';/.exec(html)[1];
  const app = readFileSync(new URL('app.js', dir), 'utf8');
  const moduleVersion = /const MODULE_VERSION = '([^']+)';/.exec(app)?.[1];
  assert.equal(moduleVersion, pageVersion);
});

test('every local module import is versioned by the loader', () => {
  const sources = readdirSync(dir).filter((f) => f.endsWith('.js'));
  const imported = new Set(['app.js']);
  for (const file of sources) {
    const text = readFileSync(new URL(file, dir), 'utf8');
    for (const m of text.matchAll(/from\s+'\.\/([\w.-]+\.js)'/g)) imported.add(m[1]);
  }
  for (const file of imported) assert.ok(listed.includes(file), `${file} is imported but not in MODULES`);
});

test('no module or stylesheet is loaded straight from index.html without a version', () => {
  assert.doesNotMatch(html, /<script[^>]+src="\.\//);
  assert.doesNotMatch(html, /<link[^>]+href="\.\/app\.css"/);
});
