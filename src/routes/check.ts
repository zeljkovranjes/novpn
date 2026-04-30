import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { env } from '../lib/env.js';
import { isIpAddress } from '../lib/ip.js';
import { checkIp } from '../services/check.js';

// Ordered most-authoritative-first. All only meaningful behind a trusted
// reverse proxy/CDN that strips/overwrites these on inbound requests.
const CLIENT_IP_HEADERS = [
  'cf-connecting-ip',     // Cloudflare
  'cf-connecting-ipv6',   // Cloudflare (IPv6-only fallback)
  'cf-pseudo-ipv4',       // Cloudflare Pseudo IPv4 (IPv6-origin clients)
  'true-client-ip',       // Cloudflare Enterprise / Akamai
  'fastly-client-ip',     // Fastly
  'fly-client-ip',        // Fly.io
  'x-vercel-forwarded-for', // Vercel (single client IP)
  'x-azure-clientip',     // Azure Front Door
  'x-azure-socketip',     // Azure Front Door (socket-level)
  'x-appengine-user-ip',  // Google App Engine
  'x-real-ip',            // nginx convention
  'x-client-ip',          // generic
  'x-cluster-client-ip',  // some load balancers
] as const;

function normalizeClientIp(raw: string): string | null {
  let v = raw.trim();
  if (!v) return null;
  // [2001:db8::1]:port → 2001:db8::1
  if (v.startsWith('[')) {
    const close = v.indexOf(']');
    if (close < 0) return null;
    v = v.slice(1, close);
  } else if (v.includes('.') && v.indexOf(':') > 0) {
    // 1.2.3.4:5678 → 1.2.3.4
    v = v.slice(0, v.indexOf(':'));
  }
  return v || null;
}

function parseForwardedHeader(value: string): string | null {
  // RFC 7239: pick the first element's `for=` token.
  const first = value.split(',')[0] ?? '';
  const m = /(?:^|;\s*)for=("[^"]*"|[^;,\s]+)/i.exec(first);
  if (!m) return null;
  let val = m[1]!;
  if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
  if (!val) return null;
  if (val.startsWith('_') || val.toLowerCase() === 'unknown') return null;
  return normalizeClientIp(val);
}

function getClientIp(c: Context): string | null {
  // Walk every candidate; only return a value that's a valid IP, so a
  // higher-priority header carrying garbage doesn't poison the result.
  for (const name of CLIENT_IP_HEADERS) {
    const raw = c.req.header(name);
    if (!raw) continue;
    const ip = normalizeClientIp(raw);
    if (ip && isIpAddress(ip)) return ip;
  }
  const fwd = c.req.header('forwarded');
  if (fwd) {
    const ip = parseForwardedHeader(fwd);
    if (ip && isIpAddress(ip)) return ip;
  }
  // Multi-value, attacker-controlled if no proxy is in front; checked last.
  const xff = c.req.header('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0];
    if (first) {
      const ip = normalizeClientIp(first);
      if (ip && isIpAddress(ip)) return ip;
    }
  }
  return null;
}

export const checkRoutes = new Hono();

const KNOWN_FLAGS = ['abuse', 'tor', 'proxy', 'datacenter', 'hosting'] as const;
const MAX_FLAGS = 16;
const MAX_FLAG_KEY = 32;

function isValidFlagKey(key: string): boolean {
  if (!key || key.length > MAX_FLAG_KEY) return false;
  return /^[a-z0-9_-]+$/i.test(key);
}

function flagsFromQuery(q: URLSearchParams): string[] {
  const out = new Set<string>();
  for (const [key, val] of q.entries()) {
    if (out.size >= MAX_FLAGS) break;
    if (key === 'ip' || key === 'all') continue;
    if (!isValidFlagKey(key)) continue;
    if (val === 'true' || val === '1') out.add(key.toLowerCase());
  }
  if (q.get('all') === 'true' || q.get('all') === '1') {
    for (const k of KNOWN_FLAGS) {
      if (out.size >= MAX_FLAGS) break;
      out.add(k);
    }
  }
  return [...out];
}

checkRoutes.get('/check', async (c) => {
  const ip = c.req.query('ip');
  if (!ip) return c.json({ error: 'ip query param required' }, 400);
  if (!isIpAddress(ip)) return c.json({ error: 'invalid IP address' }, 400);
  const url = new URL(c.req.url);
  const extras = flagsFromQuery(url.searchParams);
  return c.json(await checkIp(ip, extras));
});

checkRoutes.get('/check/me', async (c) => {
  const ip = getClientIp(c);
  if (!ip) return c.json({ error: 'no client ip header found' }, 400);
  if (!isIpAddress(ip)) return c.json({ error: 'client ip is not a valid address', ip }, 400);
  const url = new URL(c.req.url);
  const extras = flagsFromQuery(url.searchParams);
  return c.json(await checkIp(ip, extras));
});

const BatchBody = z
  .object({
    ips: z.array(z.string()).min(1).max(env.batchCheckMax),
  })
  .catchall(z.boolean().optional());

checkRoutes.post('/check/batch', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid json body' }, 400);
  }
  const parsed = BatchBody.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid body', details: parsed.error.flatten() }, 400);
  }
  const { ips, ...rest } = parsed.data;
  const extras: string[] = [];
  for (const [k, v] of Object.entries(rest)) {
    if (extras.length >= MAX_FLAGS) break;
    if (!isValidFlagKey(k)) continue;
    if (v === true) extras.push(k.toLowerCase());
  }

  const results = [];
  for (const ip of ips) {
    if (!isIpAddress(ip)) {
      results.push({ ip, error: 'invalid IP address' });
      continue;
    }
    results.push(await checkIp(ip, extras));
  }
  return c.json({ results });
});
