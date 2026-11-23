/**
 * APP-027 (audit 2026-11-22): the client IP behind per-key IP allowlists, the
 * dashboard login limiter and the audit log came from CF-Connecting-IP or the
 * LEFTMOST X-Forwarded-For entry on every request, both written by the client.
 * A stolen IP-restricted key worked from anywhere with one header.
 */
import { describe, expect, it } from "vitest";

import { clientIpOf } from "../../client-ip.js";

const ctx = (peer: string | undefined, headers: Record<string, string> = {}) => ({
  env: peer === undefined ? {} : { incoming: { socket: { remoteAddress: peer } } },
  req: { header: (name: string) => headers[name.toLowerCase()] },
});

describe("clientIpOf", () => {
  it("a direct client from the internet is its socket address; its headers are ignored", () => {
    expect(
      clientIpOf(ctx("203.0.113.9", { "x-forwarded-for": "10.1.2.3", "cf-connecting-ip": "10.1.2.3" }) as never, {})
    ).toBe("203.0.113.9");
  });

  it("behind a proxy on the internal network, the client is the rightmost hop that is not a proxy", () => {
    // The client wrote the first entry itself; the proxy appended the real one.
    expect(
      clientIpOf(ctx("172.18.0.5", { "x-forwarded-for": "10.1.2.3, 198.51.100.7" }) as never, {})
    ).toBe("198.51.100.7");
  });

  it("an IPv4-mapped socket address is reported as IPv4", () => {
    expect(clientIpOf(ctx("::ffff:203.0.113.9") as never, {})).toBe("203.0.113.9");
  });

  it("with MNEMO_TRUSTED_PROXY_IP set, only that peer's headers count", () => {
    const env = { MNEMO_TRUSTED_PROXY_IP: "172.18.0.5" };
    expect(clientIpOf(ctx("172.18.0.5", { "x-forwarded-for": "198.51.100.7" }) as never, env)).toBe("198.51.100.7");
    expect(clientIpOf(ctx("172.18.0.9", { "x-forwarded-for": "198.51.100.7" }) as never, env)).toBe("172.18.0.9");
  });

  it("final review I4: CF-Connecting-IP and X-Real-IP count only when named in MNEMO_TRUSTED_PROXY_HEADER", () => {
    // Behind nginx/Caddy/Traefik (not Cloudflare) the client's own header
    // passes through untouched: believing it by default forged the IP.
    const spoofed = { "cf-connecting-ip": "198.51.100.8", "x-forwarded-for": "198.51.100.7" };
    expect(clientIpOf(ctx("172.18.0.5", spoofed) as never, {})).toBe("198.51.100.7");
    expect(clientIpOf(ctx("172.18.0.5", { "x-real-ip": "198.51.100.8" }) as never, {})).toBe("172.18.0.5");
    const cf = { MNEMO_TRUSTED_PROXY_HEADER: "cf-connecting-ip" };
    expect(clientIpOf(ctx("172.18.0.5", spoofed) as never, cf)).toBe("198.51.100.8");
    expect(clientIpOf(ctx("203.0.113.9", spoofed) as never, cf)).toBe("203.0.113.9");
  });

  it("a proxy that forwards nothing leaves its own address", () => {
    expect(clientIpOf(ctx("172.18.0.5") as never, {})).toBe("172.18.0.5");
  });
});
