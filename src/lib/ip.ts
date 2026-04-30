const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const HEX16_RE = /^[0-9a-f]{1,4}$/i;

export type IpVersion = 4 | 6;

export type ParsedRangeV4 = {
  version: 4;
  start: number;
  end: number;
  cidr: string;
};

export type ParsedRangeV6 = {
  version: 6;
  start: Buffer;
  end: Buffer;
  cidr: string;
};

export type ParsedRange = ParsedRangeV4 | ParsedRangeV6;

// ===== IPv4 =====

export function isIpv4(s: string): boolean {
  return IPV4_RE.test(s);
}

export function ipv4ToInt(ip: string): number {
  if (!IPV4_RE.test(ip)) throw new Error(`invalid IPv4: ${ip}`);
  const parts = ip.split('.');
  return (
    ((Number(parts[0]) << 24) >>> 0) +
    (Number(parts[1]) << 16) +
    (Number(parts[2]) << 8) +
    Number(parts[3])
  );
}

export function intToIpv4(n: number): string {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join('.');
}

// ===== IPv6 =====

export function isIpv6(s: string): boolean {
  try {
    ipv6ToBuffer(s);
    return true;
  } catch {
    return false;
  }
}

export function ipv6ToBuffer(ip: string): Buffer {
  const s = ip.trim();
  if (!s || s.includes(' ')) throw new Error(`invalid IPv6: ${ip}`);

  // Forbid more than one "::"
  const dcCount = (s.match(/::/g) ?? []).length;
  if (dcCount > 1) throw new Error(`invalid IPv6: ${ip}`);

  let head: string[];
  let tail: string[];
  if (dcCount === 1) {
    const [left, right] = s.split('::', 2);
    head = left ? left.split(':') : [];
    tail = right ? right.split(':') : [];
  } else {
    head = s.split(':');
    tail = [];
  }

  // Handle trailing IPv4 (e.g. ::ffff:1.2.3.4)
  let trailingV4: number[] | null = null;
  const lastTail = tail[tail.length - 1];
  const lastHead = head[head.length - 1];
  const last = tail.length ? lastTail : lastHead;
  if (last && last.includes('.')) {
    if (!IPV4_RE.test(last)) throw new Error(`invalid IPv4 suffix in IPv6: ${ip}`);
    const v4int = ipv4ToInt(last);
    trailingV4 = [(v4int >>> 24) & 0xff, (v4int >>> 16) & 0xff, (v4int >>> 8) & 0xff, v4int & 0xff];
    if (tail.length) tail = tail.slice(0, -1);
    else head = head.slice(0, -1);
  }

  for (const h of [...head, ...tail]) {
    if (!HEX16_RE.test(h)) throw new Error(`invalid IPv6 hextet "${h}" in: ${ip}`);
  }

  const headHextets = head.length;
  const tailHextets = tail.length;
  const v4Hextets = trailingV4 ? 2 : 0;
  const explicit = headHextets + tailHextets + v4Hextets;

  let hextets: number[];
  if (dcCount === 1) {
    if (explicit > 8) throw new Error(`too many hextets in IPv6: ${ip}`);
    const zeros = new Array(8 - explicit).fill(0);
    hextets = [
      ...head.map((h) => parseInt(h, 16)),
      ...zeros,
      ...tail.map((h) => parseInt(h, 16)),
    ];
  } else {
    if (explicit !== 8) throw new Error(`expected 8 hextets in IPv6: ${ip}`);
    hextets = head.map((h) => parseInt(h, 16));
  }

  const buf = Buffer.alloc(16);
  if (trailingV4) {
    // Replace the last two hextets with the v4 bytes.
    for (let i = 0; i < 6; i += 1) {
      const v = hextets[i] ?? 0;
      buf[i * 2] = (v >>> 8) & 0xff;
      buf[i * 2 + 1] = v & 0xff;
    }
    buf[12] = trailingV4[0]!;
    buf[13] = trailingV4[1]!;
    buf[14] = trailingV4[2]!;
    buf[15] = trailingV4[3]!;
  } else {
    for (let i = 0; i < 8; i += 1) {
      const v = hextets[i] ?? 0;
      buf[i * 2] = (v >>> 8) & 0xff;
      buf[i * 2 + 1] = v & 0xff;
    }
  }
  return buf;
}

export function bufferToIpv6(buf: Buffer): string {
  if (buf.length !== 16) throw new Error('IPv6 buffer must be 16 bytes');
  const hextets: number[] = [];
  for (let i = 0; i < 8; i += 1) hextets.push((buf[i * 2]! << 8) | buf[i * 2 + 1]!);

  // Find longest run of zeros (length >= 2) to compress.
  let bestStart = -1;
  let bestLen = 0;
  let curStart = -1;
  let curLen = 0;
  for (let i = 0; i < 8; i += 1) {
    if (hextets[i] === 0) {
      if (curStart < 0) curStart = i;
      curLen += 1;
      if (curLen > bestLen) {
        bestLen = curLen;
        bestStart = curStart;
      }
    } else {
      curStart = -1;
      curLen = 0;
    }
  }

  if (bestLen < 2) {
    return hextets.map((h) => h.toString(16)).join(':');
  }
  const before = hextets.slice(0, bestStart).map((h) => h.toString(16));
  const after = hextets.slice(bestStart + bestLen).map((h) => h.toString(16));
  return `${before.join(':')}::${after.join(':')}`;
}

function v6PrefixEnd(start: Buffer, prefix: number): Buffer {
  const end = Buffer.from(start);
  if (prefix < 0 || prefix > 128) throw new Error(`invalid v6 prefix: ${prefix}`);
  const fullBytes = Math.floor(prefix / 8);
  const bits = prefix % 8;
  if (fullBytes < 16) {
    if (bits > 0) {
      const keep = 0xff << (8 - bits);
      const mask = keep & 0xff;
      end[fullBytes] = (start[fullBytes]! & mask) | (~mask & 0xff);
      for (let i = fullBytes + 1; i < 16; i += 1) end[i] = 0xff;
    } else {
      for (let i = fullBytes; i < 16; i += 1) end[i] = 0xff;
    }
  }
  return end;
}

function v6PrefixStart(start: Buffer, prefix: number): Buffer {
  const out = Buffer.from(start);
  if (prefix < 0 || prefix > 128) throw new Error(`invalid v6 prefix: ${prefix}`);
  const fullBytes = Math.floor(prefix / 8);
  const bits = prefix % 8;
  if (bits > 0 && fullBytes < 16) {
    const mask = (0xff << (8 - bits)) & 0xff;
    out[fullBytes] = start[fullBytes]! & mask;
    for (let i = fullBytes + 1; i < 16; i += 1) out[i] = 0;
  } else {
    for (let i = fullBytes; i < 16; i += 1) out[i] = 0;
  }
  return out;
}

export function compareBuf(a: Buffer, b: Buffer): number {
  return a.compare(b);
}

/**
 * Coerce whatever the SQLite driver hands back for a BLOB column into a
 * Buffer. better-sqlite3 returns Buffer; Cloudflare D1 returns ArrayBuffer;
 * other shims may return Uint8Array. The downstream IPv6 helpers assume
 * Buffer (or at least Uint8Array), so normalize at the boundary.
 */
export function toBuffer(v: unknown): Buffer {
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Uint8Array) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  if (v instanceof ArrayBuffer) return Buffer.from(v);
  // Some drivers (e.g. local D1 emulation through miniflare's IPC bridge)
  // serialize BLOBs as plain arrays of bytes or { type: 'Buffer', data: [] }.
  if (Array.isArray(v)) return Buffer.from(v as number[]);
  if (
    typeof v === 'object' &&
    v !== null &&
    Array.isArray((v as { data?: unknown }).data)
  ) {
    return Buffer.from((v as { data: number[] }).data);
  }
  throw new Error(
    `expected BLOB-like value, got ${typeof v} (${
      v === null ? 'null' : (v as object).constructor?.name ?? 'unknown'
    })`,
  );
}

// ===== Version detection =====

export function detectIpVersion(s: string): IpVersion | null {
  if (isIpv4(s)) return 4;
  if (isIpv6(s)) return 6;
  return null;
}

export function isIpAddress(s: string): boolean {
  return detectIpVersion(s) !== null;
}

// ===== Line parsing =====

export function parseLine(raw: string): ParsedRange | null {
  const stripped = raw.split('#')[0]?.trim() ?? '';
  if (!stripped) return null;
  return parseRangeToken(stripped);
}

export function parseRangeToken(token: string): ParsedRange | null {
  const t = token.trim();
  if (!t) return null;

  if (t.includes('/')) {
    const slash = t.indexOf('/');
    const ip = t.slice(0, slash);
    const prefixStr = t.slice(slash + 1);
    if (!ip || !prefixStr) return null;
    const prefix = Number(prefixStr);
    if (!Number.isInteger(prefix) || prefix < 0) return null;

    if (IPV4_RE.test(ip)) {
      if (prefix > 32) return null;
      const ipInt = ipv4ToInt(ip);
      const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
      const start = (ipInt & mask) >>> 0;
      const end = (start | (~mask >>> 0)) >>> 0;
      return { version: 4, start, end, cidr: `${intToIpv4(start)}/${prefix}` };
    }

    if (isIpv6(ip)) {
      if (prefix > 128) return null;
      const startRaw = ipv6ToBuffer(ip);
      const start = v6PrefixStart(startRaw, prefix);
      const end = v6PrefixEnd(start, prefix);
      return { version: 6, start, end, cidr: `${bufferToIpv6(start)}/${prefix}` };
    }
    return null;
  }

  // Range: a-b
  if (t.includes('-') && !t.includes(':')) {
    // Use full split (no limit) so "1.2.3.4-1.2.3.10-extra" is rejected
    // rather than silently truncated by the 2-arg form.
    const parts = t.split('-');
    if (parts.length !== 2) return null;
    const [a, b] = parts;
    if (!a || !b) return null;
    if (IPV4_RE.test(a) && IPV4_RE.test(b)) {
      const start = ipv4ToInt(a);
      const end = ipv4ToInt(b);
      if (end < start) return null;
      return { version: 4, start, end, cidr: `${a}-${b}` };
    }
    return null;
  }

  // Bare IPv4 host
  if (IPV4_RE.test(t)) {
    const ipInt = ipv4ToInt(t);
    return { version: 4, start: ipInt, end: ipInt, cidr: `${t}/32` };
  }

  // Bare IPv6 host
  if (isIpv6(t)) {
    const buf = ipv6ToBuffer(t);
    return { version: 6, start: buf, end: Buffer.from(buf), cidr: `${bufferToIpv6(buf)}/128` };
  }

  return null;
}
