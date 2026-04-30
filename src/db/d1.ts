import { Kysely } from 'kysely';
import { D1Dialect } from 'kysely-d1';
import { setDb } from './db.js';
import type { Database as DB } from './schema.js';

// D1Database type comes from @cloudflare/workers-types via tsconfig.
export function initWorkerDb(d1: D1Database): Kysely<DB> {
  const k = new Kysely<DB>({ dialect: new D1Dialect({ database: d1 }) });
  setDb(k);
  return k;
}
