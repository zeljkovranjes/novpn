import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { optionalApiSecret, requireApiSecret } from './lib/auth.js';
import { checkRoutes } from './routes/check.js';
import { providerRoutes } from './routes/providers.js';
import { metaRoutes } from './routes/meta.js';

export type Bindings = {
  DB?: D1Database;
  API_SECRET?: string;
};

export type AppEnv = { Bindings: Bindings };

export function buildApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use('*', logger());

  app.get('/', (c) =>
    c.json({
      name: 'novpn',
      version: '0.1.0',
      api: '/v1',
      docs: 'https://github.com/zeljkovranjes/novpn',
      auth_required: hasApiSecret(c.env),
    }),
  );

  app.get('/health', (c) => c.json({ status: 'ok' }));

  // Read-only routes: public when API_SECRET is unset, gated when set.
  const v1Public = new Hono<AppEnv>();
  v1Public.use('*', optionalApiSecret);
  v1Public.route('/', metaRoutes);
  v1Public.route('/', checkRoutes);
  app.route('/v1', v1Public);

  // Admin routes: always require API_SECRET; 503 if not configured.
  const v1Admin = new Hono<AppEnv>();
  v1Admin.use('*', requireApiSecret);
  v1Admin.route('/', providerRoutes);
  app.route('/v1', v1Admin);

  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: 'internal_error' }, 500);
  });

  return app;
}

function hasApiSecret(env: Bindings | undefined): boolean {
  if (env?.API_SECRET) return true;
  // Node fallback — env vars only exist in Node.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proc = (globalThis as any).process;
  if (proc?.env?.API_SECRET) return true;
  return false;
}
