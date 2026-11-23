/**
 * Where a webhook may be sent (APP-005, audit 2026-11-22).
 *
 * A webhook is an HTTP request this server makes because a caller asked it to.
 * Left unchecked, a key that can write could aim it at whatever only the server
 * can reach — the embedding service on the compose network, a cloud metadata
 * endpoint, the database's admin port — and read the answer back.
 *
 * Two rules, both on by default:
 *   • https only (MNEMO_WEBHOOK_ALLOW_HTTP=true lifts it);
 *   • never a loopback, private, link-local, carrier-NAT, multicast or
 *     unspecified address, whether written literally or reached through a name
 *     that resolves to one (MNEMO_WEBHOOK_ALLOW_PRIVATE=true lifts it, for an
 *     installation whose receivers are internal on purpose).
 *
 * The check runs when an endpoint is registered or changed and again before
 * every delivery, since a name can be re-pointed after it was accepted. A name
 * that does not resolve is not refused here: the delivery fails by itself.
 * What this does not close is a resolver that answers differently between this
 * lookup and the connection the HTTP client opens a moment later; redirects are
 * not followed, and of the receiver's response only the status code is kept, so
 * such a target can be reached but not read back.
 */
import { BlockList, isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";

export interface WebhookUrlPolicy {
  allowHttp: boolean;
  allowPrivate: boolean;
}

export type WebhookUrlRefusal =
  | "invalid_url"
  | "must_be_https"
  | "credentials_in_url"
  | "private_address";

export type WebhookUrlCheck = { ok: true } | { ok: false; reason: WebhookUrlRefusal; message: string };

type Lookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], // "this network", includes the unspecified address
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15], // benchmarking
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, includes broadcast
] as const) {
  blocked.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96], // NAT64
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
] as const) {
  blocked.addSubnet(net, prefix, "ipv6");
}

/**
 * The IPv4 address an IPv6 one carries, if any: IPv4-mapped ::ffff:a.b.c.d,
 * IPv4-compatible ::a.b.c.d (also in the hex form ::7f00:1 the URL parser
 * writes) and 6to4 2002:AABB:CCDD::. `ip` must already be a valid IPv6 literal.
 */
function embeddedIpv4(ip: string): string | null {
  let s = ip.replace(/%.*$/, "");
  const dotted = /^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(2).map(Number) as [number, number, number, number];
    s = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = s.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = (tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill("0"), ...t]).map(
    (g) => parseInt(g, 16)
  );
  const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  if (groups[0] === 0x2002) return v4(groups[1]!, groups[2]!);
  if (groups.slice(0, 5).every((g) => g === 0) && (groups[5] === 0 || groups[5] === 0xffff))
    return v4(groups[6]!, groups[7]!);
  return null;
}

/** Whether an IP address is one a webhook must not be sent to. */
export function isBlockedAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return blocked.check(ip, "ipv4");
  if (family === 6) {
    const v4 = embeddedIpv4(ip);
    return (v4 !== null && blocked.check(v4, "ipv4")) || blocked.check(ip, "ipv6");
  }
  return true; // not an address at all: never deliver to it
}

export function webhookUrlPolicyFromEnv(
  env: Record<string, string | undefined> = process.env
): WebhookUrlPolicy {
  return {
    allowHttp: env["MNEMO_WEBHOOK_ALLOW_HTTP"] === "true",
    allowPrivate: env["MNEMO_WEBHOOK_ALLOW_PRIVATE"] === "true",
  };
}

const defaultLookup: Lookup = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

const refuse = (reason: WebhookUrlRefusal, message: string): WebhookUrlCheck => ({
  ok: false,
  reason,
  message,
});

/** Decide whether a webhook may be sent to `raw`. Never throws. */
export async function checkWebhookUrl(
  raw: string,
  opts: { policy?: WebhookUrlPolicy; lookup?: Lookup } = {}
): Promise<WebhookUrlCheck> {
  const policy = opts.policy ?? webhookUrlPolicyFromEnv();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return refuse("invalid_url", "The webhook URL is not a valid URL.");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && policy.allowHttp)) {
    return refuse(
      "must_be_https",
      "The webhook URL must use https (an operator can allow http with MNEMO_WEBHOOK_ALLOW_HTTP=true)."
    );
  }
  if (url.username !== "" || url.password !== "") {
    return refuse("credentials_in_url", "The webhook URL must not carry a user name or password.");
  }
  if (policy.allowPrivate) return { ok: true };

  const privateTarget = refuse(
    "private_address",
    "The webhook URL points at a loopback, private or link-local address (an operator can allow internal receivers with MNEMO_WEBHOOK_ALLOW_PRIVATE=true)."
  );
  // WHATWG URL already normalises 2130706433, 0x7f.0.0.1 and friends to dotted form.
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(host) !== 0) return isBlockedAddress(host) ? privateTarget : { ok: true };
  if (host === "localhost" || host.endsWith(".localhost")) return privateTarget;

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await (opts.lookup ?? defaultLookup)(host);
  } catch {
    return { ok: true }; // does not resolve now: the delivery itself will fail
  }
  return addresses.some((a) => isBlockedAddress(a.address)) ? privateTarget : { ok: true };
}
