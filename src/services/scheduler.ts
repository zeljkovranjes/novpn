import cron from 'node-cron';
import { env } from '../lib/env.js';
import { getDb } from '../db/db.js';
import { refreshAllProviders, refreshProvider } from './providers.js';

let task: cron.ScheduledTask | null = null;

export function startScheduler(): void {
  if (task) {
    // Idempotent: if a previous task is still registered, tear it down before
    // creating a new one so we don't leak a node-cron timer reference.
    stopScheduler();
  }
  if (env.disableCron) {
    console.log('cron disabled (DISABLE_CRON=1)');
    return;
  }
  if (!cron.validate(env.refreshCron)) {
    console.error(`invalid REFRESH_CRON "${env.refreshCron}", scheduler not started`);
    return;
  }
  task = cron.schedule(
    env.refreshCron,
    () => {
      void runScheduledRefresh();
    },
    { scheduled: true },
  );
  console.log(`scheduler started: REFRESH_CRON="${env.refreshCron}"`);
}

export function stopScheduler(): void {
  if (task) {
    try {
      task.stop();
      // node-cron's task.stop() pauses; destroy() releases the underlying
      // timer so the event loop can exit cleanly during shutdown.
      const t = task as unknown as { destroy?: () => void };
      t.destroy?.();
    } catch {
      // ignore — best-effort shutdown
    }
    task = null;
  }
}

async function runScheduledRefresh(): Promise<void> {
  const jitter = Math.floor(Math.random() * 60_000);
  await new Promise((r) => setTimeout(r, jitter));
  console.log('scheduled refresh starting');
  try {
    const results = await refreshAllProviders();
    const ok = results.filter((r) => r.status === 'ok').length;
    const partial = results.filter((r) => r.status === 'partial').length;
    const failed = results.filter((r) => r.status === 'failed').length;
    console.log(`scheduled refresh done: ${ok} ok, ${partial} partial, ${failed} failed`);
  } catch (err) {
    console.error('scheduled refresh threw:', (err as Error).message);
  }
}

export async function refreshNeverFetched(): Promise<void> {
  const rows = await getDb()
    .selectFrom('providers')
    .select('id')
    .where('enabled', '=', 1)
    .where('last_refresh_at', 'is', null)
    .execute();
  if (rows.length === 0) return;
  console.log(`one-shot refresh: ${rows.length} provider(s) never fetched`);
  for (const { id } of rows) {
    try {
      const r = await refreshProvider(id);
      console.log(`  ${id}: ${r.status} (${r.total_ranges} ranges)`);
    } catch (err) {
      console.error(`  ${id}: failed:`, (err as Error).message);
    }
  }
}
