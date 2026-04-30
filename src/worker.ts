import { buildApp } from './app.js';
import { initWorkerDb } from './db/d1.js';
import { isDbInitialized } from './db/db.js';
import { refreshAllProviders } from './services/providers.js';

export interface Env {
  DB: D1Database;
  API_SECRET?: string;
}

const app = buildApp();

function ensureDb(env: Env): { ok: true } | { ok: false; reason: string } {
  if (isDbInitialized()) return { ok: true };
  if (!env || !env.DB) {
    return {
      ok: false,
      reason: 'D1 binding "DB" missing — check wrangler.toml [[d1_databases]] block',
    };
  }
  initWorkerDb(env.DB);
  return { ok: true };
}

export default {
  fetch(req: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    const ready = ensureDb(env);
    if (!ready.ok) {
      return Response.json(
        { error: 'misconfigured', detail: ready.reason },
        { status: 500 },
      );
    }
    return app.fetch(req, env, ctx);
  },

  // Cron Trigger handler — wired via [triggers] crons in wrangler.toml.
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const ready = ensureDb(env);
    if (!ready.ok) {
      console.error('scheduled: skipping refresh,', ready.reason);
      return;
    }
    ctx.waitUntil(
      refreshAllProviders().then((results) => {
        const ok = results.filter((r) => r.status === 'ok').length;
        const partial = results.filter((r) => r.status === 'partial').length;
        const failed = results.filter((r) => r.status === 'failed').length;
        console.log(`scheduled refresh: ${ok} ok, ${partial} partial, ${failed} failed`);
      }),
    );
  },
};
