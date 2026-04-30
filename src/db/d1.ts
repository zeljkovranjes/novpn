import { Kysely } from 'kysely';
import { D1Dialect } from 'kysely-d1';
import { setDb } from './db.js';
import type { Database as DB } from './schema.js';

// D1Database type comes from @cloudflare/workers-types via tsconfig.
let d1Instance: D1Database | null = null;

export function initWorkerDb(d1: D1Database): Kysely<DB> {
  d1Instance = d1;
  const k = new Kysely<DB>({ dialect: new D1Dialect({ database: d1 }) });
  setDb(k);
  return k;
}

// Direct D1 handle for paths that need D1's native batch() API — kysely-d1
// doesn't expose batch through Kysely's transaction abstraction, and bulk
// INSERTs need it to avoid hitting the 100-param-per-statement SQLite limit.
export function getD1(): D1Database {
  if (!d1Instance) throw new Error('D1 not initialized');
  return d1Instance;
}
