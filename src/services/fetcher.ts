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
  const isJsonFormat =
    source.format === 'json-array' ||
    source.format === 'mullvad-relays' ||
    source.format === 'airvpn-status' ||
    source.format === 'ivpn-servers';
  const headers: Record<string, string> = {
    'User-Agent': 'novpn/0.1 (+https://github.com/zeljkovranjes/novpn)',
    Accept: isJsonFormat ? 'application/json' : 'text/plain, */*;q=0.1',
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
    switch (source.format) {
      case 'json-array':
        ranges = parseJsonArray(body);
        break;
      case 'mullvad-relays':
        ranges = parseMullvadRelays(body);
        break;
      case 'airvpn-status':
        ranges = parseAirvpnStatus(body);
        break;
      case 'ivpn-servers':
        ranges = parseIvpnServers(body);
        break;
      case 'tor-csv':
        ranges = parseTorCsv(body);
        break;
      default:
        ranges = parseTxt(body);
    }
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

// Mullvad's https://api.mullvad.net/app/v1/relays returns:
//   { wireguard: { relays: [{ ipv4_addr_in, ipv6_addr_in, ... }, ...] },
//     bridge:    { relays: [{ ipv4_addr_in, ... }, ...] },
//     ... }
// We extract every host IP we can find; merging happens later.
function parseMullvadRelays(body: string): ParsedRange[] {
  const data = JSON.parse(body) as {
    wireguard?: { relays?: Array<{ ipv4_addr_in?: string; ipv6_addr_in?: string }> };
    bridge?: { relays?: Array<{ ipv4_addr_in?: string; ipv6_addr_in?: string }> };
  };
  const out: ParsedRange[] = [];
  const push = (host: string | undefined) => {
    if (!host) return;
    const r = parseLine(host);
    if (r) out.push(r);
  };
  for (const r of data.wireguard?.relays ?? []) {
    push(r.ipv4_addr_in);
    push(r.ipv6_addr_in);
  }
  for (const r of data.bridge?.relays ?? []) {
    push(r.ipv4_addr_in);
    push(r.ipv6_addr_in);
  }
  return out;
}

// AirVPN's https://airvpn.org/api/status/?format=json returns:
//   { servers: [{ ip_v4_in1..ip_v4_in4, ip_v6_in1..ip_v6_in2, ... }, ...] }
// Each server exposes up to four v4 entry IPs and two v6 entry IPs as
// separate flat string fields. We pick up any non-empty field matching the
// pattern.
function parseAirvpnStatus(body: string): ParsedRange[] {
  const data = JSON.parse(body) as {
    servers?: Array<Record<string, unknown>>;
  };
  const out: ParsedRange[] = [];
  const ipKey = /^ip_v[46]_in\d+$/;
  for (const s of data.servers ?? []) {
    for (const k of Object.keys(s)) {
      if (!ipKey.test(k)) continue;
      const v = s[k];
      if (typeof v !== 'string' || !v) continue;
      const r = parseLine(v);
      if (r) out.push(r);
    }
  }
  return out;
}

// ling0x/tor-nodes/exits.csv: fingerprint,ipaddr,port — header row first.
// `ipaddr` carries v4 (e.g. 204.137.14.106) or unbracketed v6
// (e.g. 2a12:a800:2:1:45:138:16:234). We extract column 2 as the IP.
function parseTorCsv(body: string): ParsedRange[] {
  const out: ParsedRange[] = [];
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!.trim();
    if (!line) continue;
    if (i === 0 && /fingerprint/i.test(line)) continue;
    const parts = line.split(',');
    if (parts.length < 2) continue;
    const ip = parts[1]!.trim();
    const r = parseLine(ip);
    if (r) out.push(r);
  }
  return out;
}

// IVPN's https://api.ivpn.net/v5/servers.json returns:
//   { wireguard: [{ hosts: [{ host, v2ray, ... }, ...] }, ...],
//     openvpn:   [{ hosts: [{ host, ... }, ...] }, ...] }
// We extract `host` (the public entry IP) and `v2ray` (alternate entry, when
// present). The `ipv6.local_ip` field is a ULA (fd00::/8) used INSIDE the
// tunnel — not a public exit, so we deliberately ignore it.
function parseIvpnServers(body: string): ParsedRange[] {
  const data = JSON.parse(body) as {
    wireguard?: Array<{ hosts?: Array<{ host?: string; v2ray?: string }> }>;
    openvpn?: Array<{ hosts?: Array<{ host?: string }> }>;
  };
  const out: ParsedRange[] = [];
  const push = (host: string | undefined) => {
    if (!host) return;
    const r = parseLine(host);
    if (r) out.push(r);
  };
  for (const s of data.wireguard ?? []) {
    for (const h of s.hosts ?? []) {
      push(h.host);
      push(h.v2ray);
    }
  }
  for (const s of data.openvpn ?? []) {
    for (const h of s.hosts ?? []) {
      push(h.host);
    }
  }
  return out;
}
