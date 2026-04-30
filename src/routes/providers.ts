import { Hono, type Context } from 'hono';
import { z } from 'zod';
import {
  HttpError,
  createProvider,
  deleteProvider,
  getProvider,
  listProviders,
  patchProvider,
  refreshAllProviders,
  refreshProvider,
} from '../services/providers.js';

export const providerRoutes = new Hono();

const SourceSchema = z.object({
  url: z
    .string()
    .url()
    .max(2048)
    .refine((u) => /^https?:\/\//i.test(u), { message: 'url must be http or https' }),
  format: z.enum([
    'txt',
    'json-array',
    'mullvad-relays',
    'airvpn-status',
    'ivpn-servers',
    'tor-csv',
  ]),
});

const CreateBody = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
  category: z.string().min(1).max(64).optional(),
  enabled: z.boolean().optional(),
  sources: z.array(SourceSchema).min(1),
});

const PatchBody = z.object({
  name: z.string().min(1).max(200).optional(),
  category: z.string().min(1).max(64).optional(),
  enabled: z.boolean().optional(),
  sources: z.array(SourceSchema).min(1).optional(),
});

function asyncRefresh(c: Context, id: string) {
  const work = () =>
    refreshProvider(id).catch((err: Error) => {
      // Swallow the 409 (another refresh is already running) — that's fine.
      if (err instanceof HttpError && err.status === 409) return;
      console.error(`background refresh failed for ${id}:`, err.message);
    });
  // On Workers, setImmediate's callback would be killed when the request
  // returns. ctx.waitUntil keeps the worker alive until the work resolves.
  const exec = c.executionCtx;
  if (exec && typeof (exec as { waitUntil?: unknown }).waitUntil === 'function') {
    (exec as { waitUntil: (p: Promise<unknown>) => void }).waitUntil(work());
  } else {
    setImmediate(work);
  }
}

providerRoutes.get('/providers', async (c) => {
  return c.json({ providers: await listProviders() });
});

providerRoutes.get('/providers/:id', async (c) => {
  const p = await getProvider(c.req.param('id'));
  if (!p) return c.json({ error: 'provider not found' }, 404);
  return c.json(p);
});

providerRoutes.post('/providers', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid json body' }, 400);
  }
  const parsed = CreateBody.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid body', details: parsed.error.flatten() }, 400);
  }
  try {
    const provider = await createProvider(parsed.data);
    asyncRefresh(c, provider.id);
    return c.json({ provider, refresh: 'queued' }, 201);
  } catch (err) {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400 | 409);
    throw err;
  }
});

providerRoutes.patch('/providers/:id', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid json body' }, 400);
  }
  const parsed = PatchBody.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid body', details: parsed.error.flatten() }, 400);
  }
  try {
    const provider = await patchProvider(c.req.param('id'), parsed.data);
    if (parsed.data.sources !== undefined) asyncRefresh(c, provider.id);
    return c.json({ provider });
  } catch (err) {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400 | 404);
    throw err;
  }
});

providerRoutes.delete('/providers/:id', async (c) => {
  try {
    await deleteProvider(c.req.param('id'));
    return c.json({ ok: true });
  } catch (err) {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 404);
    throw err;
  }
});

providerRoutes.post('/providers/:id/refresh', async (c) => {
  try {
    const result = await refreshProvider(c.req.param('id'));
    return c.json(result);
  } catch (err) {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 404 | 409);
    throw err;
  }
});

providerRoutes.post('/refresh', async (c) => {
  const results = await refreshAllProviders();
  return c.json({ results });
});
