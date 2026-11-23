import { describe, it, expect } from "vitest";
import {
  deviceFingerprint,
  hashToken,
  decideRefresh,
} from "../session-token.js";

describe("deviceFingerprint", () => {
  it("returns a 64-char hex string (SHA-256)", () => {
    const fp = deviceFingerprint({
      userAgent: "Mozilla/5.0",
      acceptLanguage: "en-US",
      ipNetwork: "192.168.1.0/24",
    });
    expect(fp).toMatch(/^[a-f0-9]{64}$/);
  });

  it("produces the same fingerprint for the same inputs", () => {
    const opts = {
      userAgent: "TestAgent/1.0",
      acceptLanguage: "es",
      ipNetwork: "10.0.0.0/8",
    };
    expect(deviceFingerprint(opts)).toBe(deviceFingerprint(opts));
  });

  it("produces different fingerprints for different userAgents", () => {
    const base = { acceptLanguage: "en", ipNetwork: "1.0.0.0/8" };
    const fp1 = deviceFingerprint({ ...base, userAgent: "AgentA" });
    const fp2 = deviceFingerprint({ ...base, userAgent: "AgentB" });
    expect(fp1).not.toBe(fp2);
  });
});

describe("hashToken", () => {
  it("returns a 64-char hex string (SHA-256)", () => {
    const hash = hashToken("some-refresh-token-12345");
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("is deterministic", () => {
    const token = "test-token";
    expect(hashToken(token)).toBe(hashToken(token));
  });

  it("produces different hashes for different tokens", () => {
    expect(hashToken("token-a")).not.toBe(hashToken("token-b"));
  });
});

describe("decideRefresh", () => {
  const DEVICE_FP = "device-fingerprint-aaa";

  it("rejects when stored record is null (token not found)", () => {
    const decision = decideRefresh({ stored: null, presentedFingerprint: DEVICE_FP });
    expect(decision.action).toBe("reject");
  });

  it("rotates when stored token is unused and device matches", () => {
    const decision = decideRefresh({
      stored: { usedAt: null, deviceFingerprint: DEVICE_FP },
      presentedFingerprint: DEVICE_FP,
    });
    expect(decision.action).toBe("rotate");
  });

  it("revokes family on refresh reuse (usedAt is not null)", () => {
    const decision = decideRefresh({
      stored: { usedAt: new Date(), deviceFingerprint: DEVICE_FP }, // determinism-ok: throwaway fixture date, not asserted
      presentedFingerprint: DEVICE_FP,
    });
    expect(decision.action).toBe("revoke_family");
    if (decision.action === "revoke_family") {
      expect(decision.reason).toBe("refresh_reuse_detected");
    }
  });

  it("revokes family on device mismatch", () => {
    const decision = decideRefresh({
      stored: { usedAt: null, deviceFingerprint: "original-device-fp" },
      presentedFingerprint: "different-device-fp",
    });
    expect(decision.action).toBe("revoke_family");
    if (decision.action === "revoke_family") {
      expect(decision.reason).toBe("device_mismatch");
    }
  });

  it("revoke_family wins over rotate even if device matches but token was used", () => {
    // usedAt takes priority (replay attack)
    const decision = decideRefresh({
      stored: { usedAt: new Date("2026-01-01"), deviceFingerprint: DEVICE_FP },
      presentedFingerprint: DEVICE_FP,
    });
    expect(decision.action).toBe("revoke_family");
    if (decision.action === "revoke_family") {
      expect(decision.reason).toBe("refresh_reuse_detected");
    }
  });
});
