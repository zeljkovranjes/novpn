import { env } from '../lib/env.js';
import { parseLine, type ParsedRange } from '../lib/ip.js';
import { validatePublicHttpUrl } from '../lib/url-guard.js';
import type { SourceConfig } from '../db/schema.js';

export type FetchOutcome =
  | { status: 'ok'; ranges: ParsedRange[]; etag: string | null; lastModified: string | null }
  | { status: 'not-modified' }
  | { status: 'failed'; error: string };

const MAX_BODY_BYTES = 50 * 1024 * 1024; // 50 MB
const MAX_REDIRECTS = 5;

export async function fetchSource(source: SourceConfig): Promise<FetchOutcome> {
  const headers: Record<string, string> = {
    'User-Agent': 'novpn/0.1 (+https://github.com/zeljkovranjes/novpn)',
    Accept: source.format === 'json-array' ? 'application/json' : 'text/plain, */*;q=0.1',
  };
  if (source.etag) headers['If-None-Match'] = source.etag;
  if (source.last_modified) headers['If-Modified-Since'] = source.last_modified;

  let currentUrl = source.url;
  let res: Response | null = null;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const guard = await validatePublicHttpUrl(currentUrl);
    if (!guard.ok) return { status: 'failed', error: `url rejected: ${guard.reason}` };

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), env.fetchTimeoutMs);
    let attempt: Response;
    try {
      attempt = await fetch(currentUrl, { headers, signal: ctrl.signal, redirect: 'manual' });
    } catch (err) {
      return { status: 'failed', error: sanitizeErr(err) };
    } finally {
      clearTimeout(timer);
    }

    if (attempt.status >= 300 && attempt.status < 400 && attempt.status !== 304) {
      const loc = attempt.headers.get('location');
      try {
        await attempt.body?.cancel();
      } catch {
        // ignore
      }
      if (!loc) return { status: 'failed', error: `redirect ${attempt.status} without location` };
      let next: URL;
      try {
        next = new URL(loc, currentUrl);
      } catch {
        return { status: 'failed', error: 'invalid redirect target' };
      }
      // Conditional headers belong to the original URL only; the redirect
      // target has its own etag space and would otherwise return bogus 304s.
      delete headers['If-None-Match'];
      delete headers['If-Modified-Since'];
      currentUrl = next.toString();
      continue;
    }

    res = attempt;
    break;
  }

  if (!res) return { status: 'failed', error: 'too many redirects' };
  if (res.status === 304) return { status: 'not-modified' };
  if (!res.ok) return { status: 'failed', error: `HTTP ${res.status}` };

  const cl = res.headers.get('content-length');
  if (cl !== null) {
    const n = Number(cl);
    if (Number.isFinite(n) && n > MAX_BODY_BYTES) {
      try {
        await res.body?.cancel();
      } catch {
        // ignore
      }
      return { status: 'failed', error: `response too large: ${n} bytes` };
    }
  }

  let body: string;
  try {
    body = await readWithCap(res, MAX_BODY_BYTES);
  } catch (err) {
    return { status: 'failed', error: sanitizeErr(err) };
  }

  let ranges: ParsedRange[];
  try {
    ranges = source.format === 'json-array' ? parseJsonArray(body) : parseTxt(body);
  } catch (err) {
    return { status: 'failed', error: sanitizeErr(err) };
  }

  return {
    status: 'ok',
    ranges,
    etag: res.headers.get('etag'),
    lastModified: res.headers.get('last-modified'),
  };
}

async function readWithCap(res: Response, cap: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > cap) {
      try {
        await reader.cancel();
      } catch {
        // ignore
      }
      throw new Error(`response exceeded ${cap} bytes`);
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let off = 0;
  for (const ch of chunks) {
    merged.set(ch, off);
    off += ch.byteLength;
  }
  return new TextDecoder('utf-8').decode(merged);
}

export function sanitizeErr(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  // Strip ASCII control chars (0x00-0x1F, 0x7F) so attacker-shaped error
  // messages cannot smuggle terminal escape sequences into logs / responses.
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    out += code < 0x20 || code === 0x7f ? '?' : raw[i];
  }
  return out.slice(0, 200);
}

function parseTxt(body: string): ParsedRange[] {
  const out: ParsedRange[] = [];
  for (const line of body.split(/\r?\n/)) {
    const r = parseLine(line);
    if (r) out.push(r);
  }
  return out;
}

function parseJsonArray(body: string): ParsedRange[] {
  const data = JSON.parse(body);
  if (!Array.isArray(data)) throw new Error('expected JSON array');
  const out: ParsedRange[] = [];
  for (const item of data) {
    if (typeof item !== 'string') continue;
    const r = parseLine(item);
    if (r) out.push(r);
  }
  return out;
}
