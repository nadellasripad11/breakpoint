import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { D1Store } from '../src/store/d1.ts';
import type { D1Like, D1Statement } from '../src/store/d1.ts';
import type { Row } from '../src/store/rows.ts';

/**
 * a stand-in for cloudflare d1 built on node:sqlite, with the same shape of api (prepare/bind/all/first/run/batch).
 * it lets the whole api test suite run against d1store without a workers runtime: `test_store=d1 npm test`.
 */
export function d1Shim(raw: DatabaseSync): D1Like {
  const make = (sql: string, params: unknown[] = []): D1Statement => ({
    bind: (...p: unknown[]) => make(sql, p),
    all: async () => ({ results: raw.prepare(sql).all(...(params as never[])) as Row[] }),
    first: async () => (raw.prepare(sql).get(...(params as never[])) as Row | undefined) ?? null,
    run: async () => ({ meta: { changes: Number(raw.prepare(sql).run(...(params as never[])).changes) } }),
  });
  return {
    prepare: (sql: string) => make(sql),
    // like d1: the statements of a batch run in order inside one transaction
    batch: async (statements: D1Statement[]) => {
      raw.exec('BEGIN');
      try {
        const out: { meta: { changes: number } }[] = [];
        for (const s of statements) out.push(await s.run());
        raw.exec('COMMIT');
        return out;
      } catch (e) {
        raw.exec('ROLLBACK');
        throw e;
      }
    },
  };
}

export function makeD1TestStore(): D1Store & { db: DatabaseSync } {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON');
  const dir = join(fileURLToPath(import.meta.url), '..', '..', 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) raw.exec(readFileSync(join(dir, f), 'utf8'));
  const store = new D1Store(d1Shim(raw)) as D1Store & { db: DatabaseSync };
  store.db = raw; // tests peek at the raw tables
  return store;
}
