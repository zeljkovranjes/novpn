import { isIP } from 'node:net';
import { ipv6ToBuffer } from './ip.js';
import { isWorkers } from './runtime.js';

// IPv4 ranges that must not be reachable from a public-only fetcher.
// Each entry is [start_uint32, end_uint32].
const PRIVATE_V4_BLOCKS: Array<[number, number]> = [
  [0x00000000, 0x00ffffff], // 0.0.0.0/8
  [0x0a000000, 0x0affffff], // 10.0.0.0/8
  [0x64400000, 0x647fffff], // 100.64.0.0/10 (CGNAT)
  [0x7f000000, 0x7fffffff], // 127.0.0.0/8 (loopback)
  [0xa9fe0000, 0xa9feffff], // 169.254.0.0/16 (link-local)
  [0xac100000, 0xac1fffff], // 172.16.0.0/12
  [0xc0000000, 0xc00000ff], // 192.0.0.0/24 (IETF)
  [0xc0000200, 0xc00002ff], // 192.0.2.0/24 (TEST-NET-1)
  [0xc0a80000, 0xc0a8ffff], // 192.168.0.0/16
  [0xc6120000, 0xc613ffff], // 198.18.0.0/15 (benchmarking)
  [0xc6336400, 0xc63364ff], // 198.51.100.0/24 (TEST-NET-2)
  [0xcb007100, 0xcb0071ff], // 203.0.113.0/24 (TEST-NET-3)
  [0xe0000000, 0xefffffff], // 224.0.0.0/4 (multicast)
  [0xf0000000, 0xffffffff], // 240.0.0.0/4 + 255.255.255.255
];

function ipv4ToInt(ip: string): number {
  const p = ip.split('.');
  return (
    ((Number(p[0]) << 24) >>> 0) +
    (Number(p[1]) << 16) +
    (Number(p[2]) << 8) +
    Number(p[3])
  );
}

function isPrivateV4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  return PRIVATE_V4_BLOCKS.some(([s, e]) => n >= s && n <= e);
}

function isPrivateV6Bytes(buf: Buffer): boolean {
  // ::/128 (unspec) and ::1/128 (loopback)
  let allZeroPrefix = true;
  for (let i = 0; i < 15; i += 1) {
    if (buf[i] !== 0) {
      allZeroPrefix = false;
      break;
    }
  }
  if (allZeroPrefix && (buf[15] === 0 || buf[15] === 1)) return true;

  // fe80::/10 — link-local
  if (buf[0] === 0xfe && (buf[1]! & 0xc0) === 0x80) return true;

  // fc00::/7 — unique local addresses
  if ((buf[0]! & 0xfe) === 0xfc) return true;

  // ff00::/8 — multicast
  if (buf[0] === 0xff) return true;

  // 2001:db8::/32 — documentation prefix (not routable)
  if (buf[0] === 0x20 && buf[1] === 0x01 && buf[2] === 0x0d && buf[3] === 0xb8) return true;

  // 64:ff9b::/96 — well-known NAT64 prefix maps to v4
  if (buf[0] === 0x00 && buf[1] === 0x64 && buf[2] === 0xff && buf[3] === 0x9b) {
    let mid = true;
    for (let i = 4; i < 12; i += 1) {
      if (buf[i] !== 0) {
        mid = false;
        break;
      }
    }
    if (mid) {
      const n = ((buf[12]! << 24) >>> 0) + (buf[13]! << 16) + (buf[14]! << 8) + buf[15]!;
      return PRIVATE_V4_BLOCKS.some(([s, e]) => n >= s && n <= e);
    }
  }

  // ::ffff:x.x.x.x — IPv4-mapped (peek at embedded v4)
  let mappedPrefix = true;
  for (let i = 0; i < 10; i += 1) {
    if (buf[i] !== 0) {
      mappedPrefix = false;
      break;
    }
  }
  if (mappedPrefix && buf[10] === 0xff && buf[11] === 0xff) {
    const n = ((buf[12]! << 24) >>> 0) + (buf[13]! << 16) + (buf[14]! << 8) + buf[15]!;
    return PRIVATE_V4_BLOCKS.some(([s, e]) => n >= s && n <= e);
  }

  return false;
}

function isPrivateV6Literal(ip: string): boolean {
  try {
    return isPrivateV6Bytes(ipv6ToBuffer(ip));
  } catch {
    // Unparseable v6 — refuse rather than allow.
    return true;
  }
}

export type GuardResult =
  | { ok: true; url: URL; addresses: string[] }
  | { ok: false; reason: string };

/**
 * Validates that a URL is safe to fetch from a server-side context:
 *   - http or https only
 *   - no embedded userinfo
 *   - hostname (or DNS resolution of it) does not point at private/internal space
 *
 * NOTE: this validates at validation time. A determined attacker controlling
 * authoritative DNS could rebind between this lookup and the actual fetch.
 * For our threat model (admin-authenticated source URLs) this guard plus
 * manual-redirect re-validation in the fetcher is sufficient.
 */
export async function validatePublicHttpUrl(raw: string): Promise<GuardResult> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'malformed url' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `scheme not allowed: ${url.protocol}` };
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'userinfo not allowed in url' };
  }

  // URL.hostname keeps the brackets around IPv6 literals; strip them.
  let host = url.hostname;
  if (!host) return { ok: false, reason: 'missing host' };
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);

  const literalKind = isIP(host);
  if (literalKind === 4) {
    if (isPrivateV4(host)) return { ok: false, reason: `private IPv4: ${host}` };
    return { ok: true, url, addresses: [host] };
  }
  if (literalKind === 6) {
    if (isPrivateV6Literal(host)) return { ok: false, reason: `private IPv6: ${host}` };
    return { ok: true, url, addresses: [host] };
  }

  // Hostname resolution: Cloudflare Workers don't expose raw DNS (`node:dns`
  // would throw at runtime even with nodejs_compat). Skip the lookup there and
  // rely on Workers' `fetch()`, which already refuses requests to RFC1918,
  // loopback, and link-local destinations. On Node we resolve ourselves.
  if (isWorkers()) {
    return { ok: true, url, addresses: [] };
  }

  const { lookup } = await import('node:dns/promises');
  let resolved: Array<{ address: string; family: number }>;
  try {
    resolved = await lookup(host, { all: true });
  } catch (err) {
    return { ok: false, reason: `dns lookup failed: ${(err as Error).message}` };
  }
  if (!resolved.length) return { ok: false, reason: 'no DNS resolution' };
  for (const { address, family } of resolved) {
    if (family === 4 && isPrivateV4(address)) {
      return { ok: false, reason: `host resolves to private IPv4: ${address}` };
    }
    if (family === 6 && isPrivateV6Literal(address)) {
      return { ok: false, reason: `host resolves to private IPv6: ${address}` };
    }
  }
  return { ok: true, url, addresses: resolved.map((r) => r.address) };
}

// Exported only for tests.
export const _internal = { isPrivateV4, isPrivateV6Literal };
