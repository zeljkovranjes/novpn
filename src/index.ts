import { serve } from '@hono/node-server';
import { buildApp } from './app.js';
import { closeDb } from './db/db.js';
import { initNodeDb } from './db/node.js';
import { runMigrations } from './db/migrate.js';
import { seedIfEmpty } from './db/seed.js';
import { env } from './lib/env.js';
import { refreshNeverFetched, startScheduler, stopScheduler } from './services/scheduler.js';

const app = buildApp();

async function main() {
  initNodeDb();
  await runMigrations('up');
  const seeded = await seedIfEmpty();
  if (seeded.inserted.length > 0) {
    console.log(`seeded ${seeded.inserted.length} default providers: ${seeded.inserted.join(', ')}`);
  }

  const server = serve({ fetch: app.fetch, port: env.port }, (info) => {
    console.log(`novpn listening on http://localhost:${info.port}`);
    console.log(`auth: ${env.apiSecret ? 'API_SECRET set (admin gated, lookups gated)' : 'open (no API_SECRET)'}`);
  });
  server.on('error', (err) => {
    console.error('http server error:', (err as Error).message);
    void closeDb().finally(() => process.exit(1));
  });

  startScheduler();
  if (env.refreshOnStart) {
    refreshNeverFetched().catch((err) => {
      console.error('initial refresh threw:', (err as Error).message);
    });
  }

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`received ${signal}, shutting down`);
    stopScheduler();
    server.close(() => {
      void closeDb().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('startup failed:', err);
  void closeDb().finally(() => process.exit(1));
});
