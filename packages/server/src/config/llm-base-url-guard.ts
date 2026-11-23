/**
 * The base URL a workspace owner may point their own LLM provider at.
 *
 * A workspace override sends every completion and embedding request of that
 * workspace to `baseUrl`, from the server's network. When the installation lets
 * workspace owners set it (instance setting `workspaceLlmOverride`), an owner
 * who is not an installation admin must not be able to aim the server at an
 * address only the server can reach: loopback, the private ranges, link-local
 * (cloud metadata lives at 169.254.169.254) and the like.
 *
 * Installation admins are not checked: they run the server and may point it at
 * an internal Ollama or proxy on purpose.
 *
 * The check runs when the URL is saved. A hostname whose DNS answer changes
 * afterwards (DNS rebinding) is not covered here; that needs a check at
 * connection time in the provider's HTTP client.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

export type BaseUrlRefusal =
  "BASE_URL_INVALID" | "BASE_URL_NOT_HTTPS" | "BASE_URL_PRIVATE_ADDRESS" | "BASE_URL_UNRESOLVABLE";

export type LookupAll = (hostname: string) => Promise<Array<{ address: string }>>;

const defaultLookup: LookupAll = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

const MAX_URL_LENGTH = 2048;

/** IPv4 dotted quad to its four octets, or null. */
function ipv4Octets(address: string): number[] | null {
  if (isIP(address) !== 4) return null;
  return address.split(".").map(Number);
}

function isNonPublicIpv4(address: string): boolean {
  const o = ipv4Octets(address);
  if (!o) return false;
  const [a, b] = o as [number, number, number, number];
  return (
    a === 0 || //                          "this" network
    a === 10 || //                         private
    a === 127 || //                        loopback
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || //         link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 168) || //         private
    (a === 192 && b === 0 && o[2] === 0) || // IETF protocol assignments
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 //                            multicast, reserved, broadcast
  );
}

function isNonPublicIpv6(address: string): boolean {
  const lower = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(lower) !== 6) return false;
  if (lower === "::" || lower === "::1") return true;
  // IPv4-mapped (::ffff:a.b.c.d) and its hex form (::ffff:7f00:1).
  const mapped = /^::ffff:(?:0:)?(.+)$/.exec(lower);
  if (mapped) {
    const tail = mapped[1]!;
    if (isIP(tail) === 4) return isNonPublicIpv4(tail);
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail);
    if (hex) {
      const hi = parseInt(hex[1]!, 16);
      const lo = parseInt(hex[2]!, 16);
      return isNonPublicIpv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return true;
  }
  const first = parseInt(lower.split(":")[0] || "0", 16);
  return (
    (first & 0xfe00) === 0xfc00 || // unique local fc00::/7
    (first & 0xffc0) === 0xfe80 || // link-local fe80::/10
    (first & 0xff00) === 0xff00 || // multicast
    lower.startsWith("64:ff9b:") || // NAT64, can embed a private IPv4
    lower.startsWith("2001:db8:") // documentation
  );
}

/** True for an IP address a workspace owner must not reach through the server. */
export function isNonPublicAddress(address: string): boolean {
  return isNonPublicIpv4(address) || isNonPublicIpv6(address);
}

/**
 * Check a base URL set by a workspace owner. `null` means acceptable.
 *
 * Refuses anything but `https://`, credentials in the URL, `localhost` names,
 * IP literals outside the public internet, and hostnames whose DNS answer
 * includes such an address (or that do not resolve at all).
 */
export async function checkWorkspaceBaseUrl(
  raw: string,
  lookup: LookupAll = defaultLookup
): Promise<BaseUrlRefusal | null> {
  if (raw.length > MAX_URL_LENGTH) return "BASE_URL_INVALID";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "BASE_URL_INVALID";
  }
  if (url.protocol !== "https:") return "BASE_URL_NOT_HTTPS";
  if (url.username || url.password) return "BASE_URL_INVALID";
  const host = url.hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
  if (!host) return "BASE_URL_INVALID";
  if (host === "localhost" || host.endsWith(".localhost")) return "BASE_URL_PRIVATE_ADDRESS";
  if (isIP(host)) return isNonPublicAddress(host) ? "BASE_URL_PRIVATE_ADDRESS" : null;
  let answers: Array<{ address: string }>;
  try {
    answers = await lookup(host);
  } catch {
    return "BASE_URL_UNRESOLVABLE";
  }
  if (answers.length === 0) return "BASE_URL_UNRESOLVABLE";
  return answers.some((a) => isNonPublicAddress(a.address)) ? "BASE_URL_PRIVATE_ADDRESS" : null;
}

export const BASE_URL_REFUSAL_MESSAGE: Record<BaseUrlRefusal, string> = {
  BASE_URL_INVALID: "baseUrl is not a valid URL (credentials in the URL are not allowed).",
  BASE_URL_NOT_HTTPS: "baseUrl must start with https://.",
  BASE_URL_PRIVATE_ADDRESS:
    "baseUrl points at a private, loopback or link-local address. Only an installation admin can set that.",
  BASE_URL_UNRESOLVABLE: "baseUrl's host name does not resolve.",
};
