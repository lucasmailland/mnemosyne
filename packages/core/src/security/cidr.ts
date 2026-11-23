// Wave X — X2.1: IPv6-aware CIDR matcher.
//
// All addresses are normalised to 128-bit BigInt using the IPv4-mapped IPv6
// space (::ffff:0:0/96). This means:
//
//   IPv4 "192.168.1.1"           -> maps to 128-bit space
//   IPv4-mapped "::ffff:c0a8:101" -> same 128-bit value
//   IPv6 "2001:db8::1"            -> native 128-bit
//
// IPv4 CIDRs like "192.168.0.0/24" are upgraded to /120 in 128-bit space.
//
// Fail-closed: any parse error returns null/false so the caller denies access.
//
// PURE MODULE — no host imports.

const IPV4_MAPPED_PREFIX = 0x0000_0000_0000_0000_ffff_0000_0000_0000n;
const IPV4_MAPPED_PREFIX_BITS = 96;

export function ipToBig(ip: string): bigint | null {
  if (ip.includes(":")) {
    return parseIPv6(ip);
  }
  if (ip.includes(".")) {
    const v4 = parseIPv4Octets(ip);
    if (v4 === null) return null;
    return IPV4_MAPPED_PREFIX | v4;
  }
  return null;
}

export function ipInCidr(ip: string, cidr: string): boolean {
  try {
    const slashIdx = cidr.lastIndexOf("/");
    let networkStr: string;
    let prefixLen: number;

    if (slashIdx === -1) {
      networkStr = cidr;
      prefixLen = 128;
    } else {
      networkStr = cidr.slice(0, slashIdx);
      const rawPrefix = parseInt(cidr.slice(slashIdx + 1), 10);
      if (isNaN(rawPrefix) || rawPrefix < 0) return false;

      if (!networkStr.includes(":")) {
        if (rawPrefix > 32) return false;
        prefixLen = IPV4_MAPPED_PREFIX_BITS + rawPrefix;
      } else {
        if (rawPrefix > 128) return false;
        prefixLen = rawPrefix;
      }
    }

    const ipBig = ipToBig(ip);
    const networkBig = ipToBig(networkStr);
    if (ipBig === null || networkBig === null) return false;

    const shift = 128n - BigInt(prefixLen);
    const mask =
      prefixLen === 0
        ? 0n
        : ((1n << 128n) - 1n) & ~((1n << shift) - 1n);

    return (ipBig & mask) === (networkBig & mask);
  } catch {
    return false;
  }
}

function parseIPv4Octets(ip: string): bigint | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let result = 0n;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const n = BigInt(parseInt(part, 10));
    if (n < 0n || n > 255n) return null;
    result = (result << 8n) | n;
  }
  return result;
}

function parseIPv6(ip: string): bigint | null {
  const v4mappedMatch = /^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (v4mappedMatch) {
    const ipv4str = v4mappedMatch[1];
    if (!ipv4str) return null;
    const v4 = parseIPv4Octets(ipv4str);
    if (v4 === null) return null;
    return IPV4_MAPPED_PREFIX | v4;
  }

  let expanded = ip;
  if (expanded.includes("::")) {
    const sides = expanded.split("::");
    if (sides.length !== 2) return null;
    const left = sides[0] ? sides[0].split(":") : [];
    const right = sides[1] ? sides[1].split(":") : [];
    const missing = 8 - left.length - right.length;
    if (missing < 0) return null;
    const fill = Array<string>(missing).fill("0");
    expanded = [...left, ...fill, ...right].join(":");
  }

  const groups = expanded.split(":");
  if (groups.length !== 8) return null;

  let result = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    result = (result << 16n) | BigInt(parseInt(g, 16));
  }
  return result;
}
