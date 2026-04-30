import { resolve } from 'node:path';

const num = (v: string | undefined, fallback: number) => {
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const bool = (v: string | undefined) => {
  if (!v) return false;
  const s = v.trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
};

export const env = {
  port: num(process.env.PORT, 3000),
  databasePath: resolve(process.env.DATABASE_PATH ?? 'data/novpn.sqlite'),
  apiSecret: process.env.API_SECRET?.trim() || null,
  refreshCron: process.env.REFRESH_CRON?.trim() || '0 3 * * *',
  disableCron: bool(process.env.DISABLE_CRON),
  refreshOnStart: !bool(process.env.DISABLE_REFRESH_ON_START),
  fetchTimeoutMs: num(process.env.FETCH_TIMEOUT_MS, 30_000),
  batchCheckMax: num(process.env.BATCH_CHECK_MAX, 1000),
} as const;
