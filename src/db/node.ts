import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { env } from '../lib/env.js';
import { getDb, isDbInitialized, setDb } from './db.js';
import type { Database as DB } from './schema.js';

export function initNodeDb(): Kysely<DB> {
  // Idempotent: if a Kysely is already registered (e.g. a reused process,
  // tests, multi-import path), reuse it instead of opening a second handle
  // to the same SQLite file.
  if (isDbInitialized()) return getDb();
  mkdirSync(dirname(env.databasePath), { recursive: true });
  const sqlite = new Database(env.databasePath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('synchronous = NORMAL');
  const k = new Kysely<DB>({ dialect: new SqliteDialect({ database: sqlite }) });
  setDb(k, async () => {
    try {
      await k.destroy();
    } catch {
      // ignore — best-effort
    }
  });
  return k;
}
