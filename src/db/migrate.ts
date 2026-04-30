import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Migrator, type Migration, type MigrationProvider } from 'kysely';
import { closeDb, getDb } from './db.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, 'migrations');

const migrationProvider: MigrationProvider = {
  async getMigrations() {
    const files = readdirSync(migrationsDir)
      .filter((f) => /\.(ts|js|mjs)$/.test(f) && !f.endsWith('.d.ts'))
      .sort();
    const migrations: Record<string, Migration> = {};
    for (const file of files) {
      const name = file.replace(/\.(ts|js|mjs)$/, '');
      const mod = (await import(pathToFileURL(join(migrationsDir, file)).href)) as Migration;
      migrations[name] = { up: mod.up, down: mod.down };
    }
    return migrations;
  },
};

export async function runMigrations(direction: 'up' | 'down' = 'up'): Promise<void> {
  const db = getDb();
  const migrator = new Migrator({ db, provider: migrationProvider });
  const result =
    direction === 'up'
      ? await migrator.migrateToLatest()
      : await migrator.migrateDown();
  for (const r of result.results ?? []) {
    if (r.status === 'Success') console.log(`migrate ${direction}: ${r.migrationName}`);
    else if (r.status === 'Error') console.error(`migrate ${direction} FAILED: ${r.migrationName}`);
  }
  if (result.error) {
    console.error(result.error);
    throw result.error instanceof Error ? result.error : new Error(String(result.error));
  }
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isMain) {
  const dir = (process.argv[2] === 'down' ? 'down' : 'up') as 'up' | 'down';
  runMigrations(dir)
    .then(() => closeDb())
    .catch(async (err) => {
      console.error(err);
      await closeDb();
      process.exit(1);
    });
}
