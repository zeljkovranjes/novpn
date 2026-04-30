import { getDb, now } from '../db/db.js';
import type {
  ProviderRow,
  RefreshStatus,
  SourceConfig,
  SourceFormat,
} from '../db/schema.js';
import {
  compareBuf,
  intToIpv4,
  bufferToIpv6,
  type ParsedRangeV4,
  type ParsedRangeV6,
} from '../lib/ip.js';
import { fetchSource, sanitizeErr } from './fetcher.js';

export type PublicProvider = Omit<ProviderRow, 'sources' | 'enabled'> & {
  enabled: boolean;
  sources: SourceConfig[];
};

export type ProviderInput = {
  id: string;
  name: string;
  category?: string;
  enabled?: boolean;
  sources: Array<{ url: string; format: SourceFormat }>;
};

export type ProviderPatch = {
  name?: string;
  category?: string;
  enabled?: boolean;
  sources?: Array<{ url: string; format: SourceFormat }>;
};

// Provider ids are lowercase only (regex is anchored, no /i flag) — they are
// stored verbatim and looked up by exact-match SQL, so case must be normalized.
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const CATEGORY_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function normalizeId(s: string): string {
  return s.trim().toLowerCase();
}

function normalizeCategory(s: string | undefined): string {
  return (s ?? 'vpn').trim().toLowerCase() || 'vpn';
}

function dedupeSources(
  sources: Array<{ url: string; format: SourceFormat }>,
): Array<{ url: string; format: SourceFormat }> {
  const seen = new Set<string>();
  const out: Array<{ url: string; format: SourceFormat }> = [];
  for (const s of sources) {
    const key = `${s.format}|${s.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

function parseSources(json: string): SourceConfig[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as SourceConfig[]) : [];
  } catch {
    return [];
  }
}

function toPublic(row: ProviderRow): PublicProvider {
  return {
    ...row,
    enabled: row.enabled === 1,
    sources: parseSources(row.sources),
  };
}

export async function listProviders(): Promise<PublicProvider[]> {
  const rows = await getDb()
    .selectFrom('providers')
    .selectAll()
    .orderBy('id')
    .execute();
  return rows.map(toPublic);
}

export async function getProvider(rawId: string): Promise<PublicProvider | null> {
  const id = normalizeId(rawId);
  const row = await getDb()
    .selectFrom('providers')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  return row ? toPublic(row) : null;
}

export async function createProvider(input: ProviderInput): Promise<PublicProvider> {
  const id = normalizeId(input.id);
  if (!ID_RE.test(id)) {
    throw new HttpError(400, 'invalid provider id (lowercase a-z, 0-9, _, -; max 64)');
  }
  if (!input.name?.trim()) throw new HttpError(400, 'name required');
  if (!input.sources?.length) throw new HttpError(400, 'at least one source required');
  const category = normalizeCategory(input.category);
  if (!CATEGORY_RE.test(category)) {
    throw new HttpError(400, 'invalid category (lowercase a-z, 0-9, _, -; max 64)');
  }
  const ts = now();
  const sources: SourceConfig[] = dedupeSources(input.sources).map((s) => ({
    url: s.url,
    format: s.format,
  }));
  try {
    await getDb()
      .insertInto('providers')
      .values({
        id,
        name: input.name.trim(),
        category,
        enabled: input.enabled === false ? 0 : 1,
        sources: JSON.stringify(sources),
        last_refresh_at: null,
        last_refresh_status: null,
        created_at: ts,
        updated_at: ts,
      })
      .execute();
  } catch (err) {
    if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
      throw new HttpError(409, `provider ${id} already exists`);
    }
    throw err;
  }
  const created = await getProvider(id);
  if (!created) throw new Error('provider missing after create');
  return created;
}

export async function patchProvider(rawId: string, patch: ProviderPatch): Promise<PublicProvider> {
  const id = normalizeId(rawId);
  const existing = await getProvider(id);
  if (!existing) throw new HttpError(404, 'provider not found');
  const update: Record<string, unknown> = { updated_at: now() };
  if (patch.name !== undefined) update.name = patch.name.trim();
  if (patch.category !== undefined) {
    const cat = normalizeCategory(patch.category);
    if (!CATEGORY_RE.test(cat)) {
      throw new HttpError(400, 'invalid category (lowercase a-z, 0-9, _, -; max 64)');
    }
    update.category = cat;
  }
  if (patch.enabled !== undefined) update.enabled = patch.enabled ? 1 : 0;
  if (patch.sources !== undefined) {
    if (!patch.sources.length) throw new HttpError(400, 'at least one source required');
    const deduped = dedupeSources(patch.sources);
    const merged: SourceConfig[] = deduped.map((s) => {
      const prior = existing.sources.find((p) => p.url === s.url && p.format === s.format);
      return prior ?? { url: s.url, format: s.format };
    });
    update.sources = JSON.stringify(merged);
  }
  await getDb().updateTable('providers').set(update).where('id', '=', id).execute();
  const updated = await getProvider(id);
  if (!updated) throw new Error('provider missing after update');
  return updated;
}

export async function deleteProvider(rawId: string): Promise<void> {
  const id = normalizeId(rawId);
  const res = await getDb().deleteFrom('providers').where('id', '=', id).executeTakeFirst();
  if (Number(res.numDeletedRows) === 0) throw new HttpError(404, 'provider not found');
}

export type RefreshSourceResult = {
  url: string;
  status: 'ok' | 'failed' | 'not-modified';
  count?: number;
  error?: string;
};

export type RefreshResult = {
  provider_id: string;
  status: RefreshStatus;
  total_ranges: number;
  sources: RefreshSourceResult[];
};

const inFlightRefresh = new Set<string>();

export function isRefreshInFlight(id: string): boolean {
  return inFlightRefresh.has(id);
}

export async function refreshProvider(rawId: string): Promise<RefreshResult> {
  const id = normalizeId(rawId);
  if (inFlightRefresh.has(id)) {
    throw new HttpError(409, 'refresh already in progress for this provider');
  }
  inFlightRefresh.add(id);
  try {
    return await refreshProviderInner(id);
  } finally {
    inFlightRefresh.delete(id);
  }
}

async function refreshProviderInner(id: string): Promise<RefreshResult> {
  const provider = await getProvider(id);
  if (!provider) throw new HttpError(404, 'provider not found');

  const updatedSources: SourceConfig[] = [];
  const results: RefreshSourceResult[] = [];
  const v4Ranges: ParsedRangeV4[] = [];
  const v6Ranges: ParsedRangeV6[] = [];
  let okCount = 0;
  let notModifiedCount = 0;

  for (const src of provider.sources) {
    const outcome = await fetchSource(src);
    const ts = now();
    if (outcome.status === 'not-modified') {
      notModifiedCount += 1;
      updatedSources.push({ ...src, last_status: 'not-modified', last_fetched_at: ts, last_error: null });
      results.push({ url: src.url, status: 'not-modified' });
      continue;
    }
    if (outcome.status === 'failed') {
      updatedSources.push({ ...src, last_status: 'failed', last_fetched_at: ts, last_error: outcome.error });
      results.push({ url: src.url, status: 'failed', error: outcome.error });
      continue;
    }
    okCount += 1;
    for (const r of outcome.ranges) {
      if (r.version === 4) v4Ranges.push(r);
      else v6Ranges.push(r);
    }
    updatedSources.push({
      ...src,
      etag: outcome.etag,
      last_modified: outcome.lastModified,
      last_status: 'ok',
      last_count: outcome.ranges.length,
      last_fetched_at: ts,
      last_error: null,
    });
    results.push({ url: src.url, status: 'ok', count: outcome.ranges.length });
  }

  const anyOk = okCount > 0;
  const anyNotModified = notModifiedCount > 0;
  const anyFailed = results.some((r) => r.status === 'failed');
  let status: RefreshStatus;
  if (anyOk && !anyFailed) status = 'ok';
  else if (anyOk && anyFailed) status = 'partial';
  else if (!anyOk && anyNotModified && !anyFailed) status = 'ok';
  else if (!anyOk && anyNotModified && anyFailed) status = 'partial';
  else status = 'failed';

  const db = getDb();
  let totalRanges = 0;

  const finishedAt = now();

  if (anyOk) {
    const mergedV4 = mergeV4(v4Ranges);
    const mergedV6 = mergeV6(v6Ranges);
    await db.transaction().execute(async (trx) => {
      await trx.deleteFrom('ip_ranges').where('provider_id', '=', id).execute();
      await trx.deleteFrom('ip_ranges_v6').where('provider_id', '=', id).execute();
      const CHUNK = 500;
      for (let i = 0; i < mergedV4.length; i += CHUNK) {
        const slice = mergedV4.slice(i, i + CHUNK).map((r) => ({
          provider_id: id,
          start_ip: r.start,
          end_ip: r.end,
          cidr: r.cidr,
        }));
        await trx.insertInto('ip_ranges').values(slice).execute();
      }
      for (let i = 0; i < mergedV6.length; i += CHUNK) {
        const slice = mergedV6.slice(i, i + CHUNK).map((r) => ({
          provider_id: id,
          start_ip: r.start,
          end_ip: r.end,
          cidr: r.cidr,
        }));
        await trx.insertInto('ip_ranges_v6').values(slice).execute();
      }
      await trx
        .updateTable('providers')
        .set({
          sources: JSON.stringify(updatedSources),
          last_refresh_at: finishedAt,
          last_refresh_status: status,
          updated_at: finishedAt,
        })
        .where('id', '=', id)
        .execute();
    });
    totalRanges = mergedV4.length + mergedV6.length;
  } else {
    await db
      .updateTable('providers')
      .set({
        sources: JSON.stringify(updatedSources),
        last_refresh_at: finishedAt,
        last_refresh_status: status,
        updated_at: finishedAt,
      })
      .where('id', '=', id)
      .execute();
    const v4count = await db
      .selectFrom('ip_ranges')
      .select(db.fn.countAll<number>().as('c'))
      .where('provider_id', '=', id)
      .executeTakeFirst();
    const v6count = await db
      .selectFrom('ip_ranges_v6')
      .select(db.fn.countAll<number>().as('c'))
      .where('provider_id', '=', id)
      .executeTakeFirst();
    totalRanges = Number(v4count?.c ?? 0) + Number(v6count?.c ?? 0);
  }

  return { provider_id: id, status, total_ranges: totalRanges, sources: results };
}

export async function refreshAllProviders(): Promise<RefreshResult[]> {
  const enabled = await getDb()
    .selectFrom('providers')
    .select('id')
    .where('enabled', '=', 1)
    .execute();
  const out: RefreshResult[] = [];
  for (const { id } of enabled) {
    try {
      out.push(await refreshProvider(id));
    } catch (err) {
      out.push({
        provider_id: id,
        status: 'failed',
        total_ranges: 0,
        sources: [{ url: '<provider>', status: 'failed', error: sanitizeErr(err) }],
      });
    }
  }
  return out;
}

function v4Cidr(start: number, end: number, original: string): string {
  // Full /0 — handled explicitly because size = 2^32 wraps to 0 in 32-bit
  // bitwise math and would otherwise be classified as /31.
  if (start === 0 && end === 0xffffffff) return '0.0.0.0/0';
  // Preserve the original token when the merged span is exactly a single host.
  if (start === end && /\/32$/.test(original)) return original;
  // If start..end is a single CIDR (power-of-two-aligned), reconstruct it.
  const size = end - start + 1;
  const log = Math.log2(size);
  if (size > 0 && Number.isInteger(log)) {
    const prefix = 32 - log;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    // The `>>> 0` is load-bearing: JS bitwise AND returns a signed 32-bit
    // value, so without it the equality fails for any start >= 2^31.
    if (((start & mask) >>> 0) === start) {
      return `${intToIpv4(start)}/${prefix}`;
    }
  }
  return `${intToIpv4(start)}-${intToIpv4(end)}`;
}

function mergeV4(ranges: ParsedRangeV4[]): ParsedRangeV4[] {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: ParsedRangeV4[] = [];
  let cur: ParsedRangeV4 = { ...sorted[0]! };
  let merged = false;
  for (let i = 1; i < sorted.length; i += 1) {
    const r = sorted[i]!;
    if (r.start <= cur.end + 1) {
      if (r.end > cur.end) {
        cur.end = r.end;
        merged = true;
      } else if (r.start !== cur.start || r.end !== cur.end) {
        merged = true;
      }
    } else {
      out.push({ ...cur, cidr: merged ? v4Cidr(cur.start, cur.end, cur.cidr) : cur.cidr });
      cur = { ...r };
      merged = false;
    }
  }
  out.push({ ...cur, cidr: merged ? v4Cidr(cur.start, cur.end, cur.cidr) : cur.cidr });
  return out;
}

function v6Cidr(start: Buffer, end: Buffer, original: string): string {
  if (compareBuf(start, end) === 0) return original;
  return `${bufferToIpv6(start)}-${bufferToIpv6(end)}`;
}

function mergeV6(ranges: ParsedRangeV6[]): ParsedRangeV6[] {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort(
    (a, b) => compareBuf(a.start, b.start) || compareBuf(a.end, b.end),
  );
  const out: ParsedRangeV6[] = [];
  let cur: ParsedRangeV6 = {
    version: 6,
    start: Buffer.from(sorted[0]!.start),
    end: Buffer.from(sorted[0]!.end),
    cidr: sorted[0]!.cidr,
  };
  let merged = false;
  for (let i = 1; i < sorted.length; i += 1) {
    const r = sorted[i]!;
    const adjacent = bufPlusOne(cur.end);
    if (compareBuf(r.start, adjacent) <= 0) {
      if (compareBuf(r.end, cur.end) > 0) {
        cur.end = Buffer.from(r.end);
        merged = true;
      } else if (compareBuf(r.start, cur.start) !== 0 || compareBuf(r.end, cur.end) !== 0) {
        merged = true;
      }
    } else {
      out.push({
        ...cur,
        cidr: merged ? v6Cidr(cur.start, cur.end, cur.cidr) : cur.cidr,
      });
      cur = {
        version: 6,
        start: Buffer.from(r.start),
        end: Buffer.from(r.end),
        cidr: r.cidr,
      };
      merged = false;
    }
  }
  out.push({
    ...cur,
    cidr: merged ? v6Cidr(cur.start, cur.end, cur.cidr) : cur.cidr,
  });
  return out;
}

function bufPlusOne(buf: Buffer): Buffer {
  const out = Buffer.from(buf);
  for (let i = out.length - 1; i >= 0; i -= 1) {
    if (out[i]! < 0xff) {
      out[i] = (out[i]! + 1) & 0xff;
      return out;
    }
    out[i] = 0;
  }
  // Overflow past max — return all-FF, which makes "adjacent" semantically infinite.
  return Buffer.alloc(buf.length, 0xff);
}

export class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}
