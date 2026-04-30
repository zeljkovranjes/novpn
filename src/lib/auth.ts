import { createHash, timingSafeEqual } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { env as nodeEnv } from './env.js';

function sha256(s: string): Buffer {
  return createHash('sha256').update(s).digest();
}

// Compare two strings in constant time without leaking length.
// Both sides hash to the same fixed 32 bytes before timingSafeEqual.
function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}

function checkBearer(header: string | undefined, secret: string): boolean {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? '');
  if (!match) return false;
  return safeEqual(match[1]!.trim(), secret);
}

// Workers expose secrets via the request context's `env`; Node has them on
// `process.env` (cached on startup into `nodeEnv.apiSecret`). Workers' c.env
// is the source of truth when set.
function readSecret(c: Context): string | null {
  const fromBinding = (c.env as { API_SECRET?: string } | undefined)?.API_SECRET;
  if (typeof fromBinding === 'string' && fromBinding.trim()) return fromBinding.trim();
  return nodeEnv.apiSecret;
}

/**
 * Required auth: API_SECRET must be set, and the request must present it.
 * Used for admin/provider endpoints.
 */
export const requireApiSecret: MiddlewareHandler = async (c, next) => {
  const secret = readSecret(c);
  if (!secret) {
    return c.json(
      { error: 'admin_disabled', detail: 'set API_SECRET to enable admin endpoints' },
      503,
    );
  }
  if (!checkBearer(c.req.header('authorization'), secret)) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  return next();
};

/**
 * Optional auth: if API_SECRET is set, require it; if not, the route is public.
 * Used for check/lookup and read-only meta endpoints.
 */
export const optionalApiSecret: MiddlewareHandler = async (c, next) => {
  const secret = readSecret(c);
  if (!secret) return next();
  if (!checkBearer(c.req.header('authorization'), secret)) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  return next();
};
