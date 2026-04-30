import type { Kysely } from 'kysely';
import type { Database as DB } from './schema.js';

// Single registered Kysely instance. Set by the runtime-specific entry:
//   - Node: src/index.ts → initNodeDb() (better-sqlite3)
//   - Workers: src/worker.ts → initWorkerDb(env.DB) (D1)
let registered: Kysely<DB> | null = null;
let nodeCleanup: (() => Promise<void> | void) | null = null;

export function setDb(db: Kysely<DB>, cleanup?: () => Promise<void> | void): void {
  // Idempotent: if a previous instance was registered, fire-and-forget its
  // cleanup so we don't leak the handle when init runs twice (e.g. test
  // reload, hot-reload, repeated wrangler dev cycles in the same process).
  const previous = nodeCleanup;
  if (previous) {
    void Promise.resolve()
      .then(previous)
      .catch(() => {
        // ignore — best-effort
      });
  }
  registered = db;
  nodeCleanup = cleanup ?? null;
}

export function isDbInitialized(): boolean {
  return registered !== null;
}

export function getDb(): Kysely<DB> {
  if (!registered) {
    throw new Error(
      'database not initialized — Node entry calls initNodeDb(); Workers fetch handler calls initWorkerDb(env.DB)',
    );
  }
  return registered;
}

export async function closeDb(): Promise<void> {
  const cleanup = nodeCleanup;
  nodeCleanup = null;
  registered = null;
  if (cleanup) await cleanup();
}

export const now = (): number => Math.floor(Date.now() / 1000);
