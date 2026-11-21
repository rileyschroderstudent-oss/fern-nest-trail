// A small stand-in for the Cloudflare D1 binding, for Node tests. It runs the real
// migration on an in-memory SQLite database (node:sqlite, built into Node 22.5+) and
// offers the parts of the D1 API the Worker uses: prepare().bind() with all(),
// first() and run(), and batch(). It is a helper, not a test file.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

const MIGRATION = readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8');

class Statement {
  constructor(db, sql, params = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }

  bind(...params) {
    return new Statement(this.db, this.sql, params);
  }

  async all() {
    // node:sqlite rows have a null prototype; D1 returns plain objects.
    return { results: this.db.prepare(this.sql).all(...this.params).map((r) => ({ ...r })), success: true };
  }

  async first() {
    const row = this.db.prepare(this.sql).get(...this.params);
    return row ? { ...row } : null;
  }

  async run() {
    this.db.prepare(this.sql).run(...this.params);
    return { success: true };
  }
}

export function createD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(MIGRATION);
  return {
    prepare: (sql) => new Statement(db, sql),
    // D1 runs a batch as one transaction.
    async batch(statements) {
      db.exec('BEGIN');
      try {
        const out = [];
        for (const s of statements) out.push(await s.all());
        db.exec('COMMIT');
        return out;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    // Test helpers, not part of D1.
    counter: (key) => db.prepare('SELECT value FROM counters WHERE key = ?').get(key)?.value ?? 0,
    rows: (sql, ...params) => db.prepare(sql).all(...params).map((r) => ({ ...r })),
  };
}

// An env and ctx for driving the Worker in tests. ctx.flush() waits for everything
// passed to waitUntil.
export function testEnv(overrides = {}) {
  return {
    ALLOWED_ORIGINS: 'http://localhost:8788',
    MODEL: 'claude-haiku-5-5',
    MOCK_ANTHROPIC: '1',
    DEMO_ENABLED: '1',
    SESSION_SECRET: 'test-secret-that-is-at-least-32-characters',
    IP_HASH_SALT: 'test-salt',
    DB: createD1(),
    ...overrides,
  };
}

export function testCtx() {
  const pending = [];
  return {
    waitUntil: (p) => pending.push(p),
    flush: async () => {
      while (pending.length) await pending.shift();
    },
  };
}
