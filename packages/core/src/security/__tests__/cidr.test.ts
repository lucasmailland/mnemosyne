import { describe, it, expect } from "vitest";
import { ipInCidr, ipToBig } from "../cidr.js";

describe("ipToBig", () => {
  it("parses a simple IPv4 address", () => {
    const result = ipToBig("0.0.0.0");
    expect(result).not.toBeNull();
  });

  it("parses 127.0.0.1 correctly", () => {
    const result = ipToBig("127.0.0.1");
    expect(result).not.toBeNull();
  });

  it("parses IPv6 loopback ::1", () => {
    const result = ipToBig("::1");
    expect(result).toBe(1n);
  });

  it("parses full IPv6 address", () => {
    const result = ipToBig("2001:0db8:0000:0000:0000:0000:0000:0001");
    expect(result).not.toBeNull();
  });

  it("parses compressed IPv6 address 2001:db8::1", () => {
    const full = ipToBig("2001:0db8:0000:0000:0000:0000:0000:0001");
    const compressed = ipToBig("2001:db8::1");
    expect(compressed).toBe(full);
  });

  it("returns null for invalid input", () => {
    expect(ipToBig("not-an-ip")).toBeNull();
    expect(ipToBig("256.0.0.1")).toBeNull();
    expect(ipToBig("")).toBeNull();
  });

  it("returns null for malformed IPv4", () => {
    expect(ipToBig("192.168.1")).toBeNull();
    expect(ipToBig("192.168.1.1.1")).toBeNull();
  });

  it("parses IPv4-mapped IPv6 ::ffff:192.168.1.1", () => {
    const v4 = ipToBig("192.168.1.1");
    const v4mapped = ipToBig("::ffff:192.168.1.1");
    expect(v4mapped).not.toBeNull();
    expect(v4mapped).toBe(v4);
  });
});

describe("ipInCidr", () => {
  describe("IPv4", () => {
    it("matches an IP within a /24 network", () => {
      expect(ipInCidr("192.168.1.100", "192.168.1.0/24")).toBe(true);
    });

    it("does not match an IP outside a /24 network", () => {
      expect(ipInCidr("192.168.2.1", "192.168.1.0/24")).toBe(false);
    });

    it("matches a /32 host address exactly", () => {
      expect(ipInCidr("10.0.0.1", "10.0.0.1/32")).toBe(true);
    });

    it("does not match a different /32 host", () => {
      expect(ipInCidr("10.0.0.2", "10.0.0.1/32")).toBe(false);
    });

    it("matches any IP with /0", () => {
      expect(ipInCidr("1.2.3.4", "0.0.0.0/0")).toBe(true);
      expect(ipInCidr("255.255.255.255", "0.0.0.0/0")).toBe(true);
    });

    it("matches a /16 supernet", () => {
      expect(ipInCidr("172.16.5.100", "172.16.0.0/16")).toBe(true);
    });

    it("rejects an IP outside /16 supernet", () => {
      expect(ipInCidr("172.17.0.1", "172.16.0.0/16")).toBe(false);
    });
  });

  describe("IPv6", () => {
    it("matches an IPv6 address in /64 block", () => {
      expect(ipInCidr("2001:db8::1", "2001:db8::/64")).toBe(true);
    });

    it("does not match an IPv6 outside /64 block", () => {
      expect(ipInCidr("2001:db9::1", "2001:db8::/64")).toBe(false);
    });

    it("matches ::1 against ::1/128", () => {
      expect(ipInCidr("::1", "::1/128")).toBe(true);
    });

    it("does not match ::2 against ::1/128", () => {
      expect(ipInCidr("::2", "::1/128")).toBe(false);
    });
  });

  describe("fail-closed", () => {
    it("returns false for invalid IP", () => {
      expect(ipInCidr("not-an-ip", "192.168.1.0/24")).toBe(false);
    });

    it("returns false for invalid CIDR", () => {
      expect(ipInCidr("192.168.1.1", "bad-cidr")).toBe(false);
    });

    it("returns false for empty strings", () => {
      expect(ipInCidr("", "")).toBe(false);
      expect(ipInCidr("192.168.1.1", "")).toBe(false);
    });

    it("returns false for invalid prefix length", () => {
      expect(ipInCidr("192.168.1.1", "192.168.1.0/33")).toBe(false);
    });
  });

  describe("no prefix (host match)", () => {
    it("matches an IP against itself (no slash)", () => {
      expect(ipInCidr("10.0.0.1", "10.0.0.1")).toBe(true);
    });

    it("does not match a different IP with no slash", () => {
      expect(ipInCidr("10.0.0.2", "10.0.0.1")).toBe(false);
    });
  });
});
