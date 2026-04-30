import { Hono } from 'hono';
import { sql } from 'kysely';
import { getDb } from '../db/db.js';

export const metaRoutes = new Hono();

metaRoutes.get('/categories', async (c) => {
  const rows = await getDb()
    .selectFrom('providers')
    .select((eb) => [
      'category',
      eb.fn.countAll<number>().as('provider_count'),
      sql<number>`SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END)`.as('enabled_count'),
    ])
    .groupBy('category')
    .orderBy('category')
    .execute();
  return c.json({
    categories: rows.map((r) => ({
      name: r.category,
      provider_count: Number(r.provider_count),
      enabled_count: Number(r.enabled_count),
      default_on: r.category === 'vpn',
      flag: r.category === 'vpn' ? null : r.category,
    })),
  });
});

metaRoutes.get('/stats', async (c) => {
  const db = getDb();

  const totalsV4 = await db
    .selectFrom('ip_ranges')
    .select((eb) => eb.fn.countAll<number>().as('c'))
    .executeTakeFirst();
  const totalsV6 = await db
    .selectFrom('ip_ranges_v6')
    .select((eb) => eb.fn.countAll<number>().as('c'))
    .executeTakeFirst();

  const v4Per = await db
    .selectFrom('ip_ranges')
    .select((eb) => ['provider_id as id', eb.fn.countAll<number>().as('c')])
    .groupBy('provider_id')
    .execute();
  const v6Per = await db
    .selectFrom('ip_ranges_v6')
    .select((eb) => ['provider_id as id', eb.fn.countAll<number>().as('c')])
    .groupBy('provider_id')
    .execute();
  const v4Map = new Map(v4Per.map((r) => [r.id, Number(r.c)]));
  const v6Map = new Map(v6Per.map((r) => [r.id, Number(r.c)]));

  const providers = await db
    .selectFrom('providers')
    .select(['id', 'name', 'category', 'enabled', 'last_refresh_at', 'last_refresh_status'])
    .orderBy('id')
    .execute();

  return c.json({
    total_ranges: Number(totalsV4?.c ?? 0) + Number(totalsV6?.c ?? 0),
    total_ranges_v4: Number(totalsV4?.c ?? 0),
    total_ranges_v6: Number(totalsV6?.c ?? 0),
    providers: providers.map((p) => ({
      id: p.id,
      name: p.name,
      category: p.category,
      enabled: p.enabled === 1,
      last_refresh_at: p.last_refresh_at,
      last_refresh_status: p.last_refresh_status,
      range_count_v4: v4Map.get(p.id) ?? 0,
      range_count_v6: v6Map.get(p.id) ?? 0,
      range_count: (v4Map.get(p.id) ?? 0) + (v6Map.get(p.id) ?? 0),
    })),
  });
});

