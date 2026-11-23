/**
 * The address a request came from (APP-027, audit 2026-11-22).
 *
 * Used by per-key IP allowlists, the dashboard login limiter and the audit
 * log. It used to come from CF-Connecting-IP or the leftmost X-Forwarded-For
 * entry of any request — headers the client writes — so a stolen
 * IP-restricted key worked from anywhere.
 *
 * The socket peer is the truth. Its forwarding headers are believed only when
 * the peer is a proxy: the one named in MNEMO_TRUSTED_PROXY_IP (comma list), or,
 * when that is not set, a peer on a loopback, private or link-local address
 * (a reverse proxy on the same host or network, the usual Docker setup). In
 * X-Forwarded-For the client is the rightmost hop that is not itself a proxy;
 * the entries to its left are the client's own claims.
 *
 * CF-Connecting-IP or X-Real-IP is used only when named in
 * MNEMO_TRUSTED_PROXY_HEADER. Without a socket (an in-process test request)
 * the old header reading is kept.
 */
import { isBlockedAddress } from "./webhook-url-guard.js";

type Ctx = {
  env?: unknown;
  req: { header(name: string): string | undefined };
};

const unmap = (ip: string) => ip.trim().replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i, "$1");

export function clientIpOf(
  c: Ctx,
  env: Record<string, string | undefined> = process.env
): string {
  const peerRaw = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)
    ?.incoming?.socket?.remoteAddress;
  if (!peerRaw) {
    return (
      c.req.header("cf-connecting-ip") ??
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
      c.req.header("x-real-ip") ??
      ""
    );
  }
  const peer = unmap(peerRaw);
  const named = (env["MNEMO_TRUSTED_PROXY_IP"] ?? "")
    .split(",")
    .map((s) => unmap(s))
    .filter(Boolean);
  const isProxy = (ip: string) => (named.length > 0 ? named.includes(ip) : isBlockedAddress(ip));
  if (!isProxy(peer)) return peer;

  // Final review I4: a single-address header (CF-Connecting-IP, X-Real-IP…)
  // is believed only when the operator names it — a proxy that does not set
  // it passes the client's own copy through.
  const namedHeader = env["MNEMO_TRUSTED_PROXY_HEADER"]?.trim().toLowerCase();
  if (namedHeader) {
    const v = c.req.header(namedHeader)?.trim();
    if (v) return unmap(v);
  }
  const hops = (c.req.header("x-forwarded-for") ?? "")
    .split(",")
    .map((s) => unmap(s))
    .filter(Boolean);
  for (let i = hops.length - 1; i >= 0; i -= 1) {
    if (!isProxy(hops[i]!)) return hops[i]!;
  }
  return hops[0] ?? peer;
}
