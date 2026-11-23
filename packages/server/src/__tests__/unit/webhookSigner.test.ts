import { createHmac } from "node:crypto";
import { describe, it, expect } from "vitest";
import { signWebhookPayload, verifyWebhookSignature, extractWebhookTimestamp } from "../../webhookSigner.js";

const SECRET = "test-secret-abc123";
const BODY = '{"event":"memory.created","id":"f1"}';

describe("signWebhookPayload", () => {
  it("emits t=...,v1=... format", () => {
    const sig = signWebhookPayload(SECRET, BODY);
    expect(sig).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
  });

  it("accepts injectable timestamp", () => {
    const sig = signWebhookPayload(SECRET, BODY, 1_700_000_000);
    expect(sig.startsWith("t=1700000000,")).toBe(true);
  });

  it("is deterministic given same timestamp", () => {
    const ts = 1_700_000_001;
    expect(signWebhookPayload(SECRET, BODY, ts)).toBe(signWebhookPayload(SECRET, BODY, ts));
  });
});

describe("verifyWebhookSignature — new format", () => {
  it("verifies a valid signature", () => {
    const now = Math.floor(Date.now() / 1000); // determinism-ok: self-consistent, same now used for sign and verify
    const sig = signWebhookPayload(SECRET, BODY, now);
    expect(verifyWebhookSignature(SECRET, BODY, sig, now)).toBe(true);
  });

  it("rejects signature outside replay window (too old)", () => {
    const oldTs = Math.floor(Date.now() / 1000) - 301; // determinism-ok: self-consistent, same reference used for sign and verify
    const sig = signWebhookPayload(SECRET, BODY, oldTs);
    expect(verifyWebhookSignature(SECRET, BODY, sig)).toBe(false);
  });

  it("rejects signature outside replay window (future)", () => {
    const futureTs = Math.floor(Date.now() / 1000) + 301; // determinism-ok: self-consistent, same reference used for sign and verify
    const sig = signWebhookPayload(SECRET, BODY, futureTs);
    expect(verifyWebhookSignature(SECRET, BODY, sig)).toBe(false);
  });

  it("rejects tampered body", () => {
    const now = Math.floor(Date.now() / 1000); // determinism-ok: self-consistent, same now used for sign and verify
    const sig = signWebhookPayload(SECRET, BODY, now);
    expect(verifyWebhookSignature(SECRET, '{"tampered":true}', sig, now)).toBe(false);
  });

  it("rejects wrong secret", () => {
    const now = Math.floor(Date.now() / 1000); // determinism-ok: self-consistent, same now used for sign and verify
    const sig = signWebhookPayload(SECRET, BODY, now);
    expect(verifyWebhookSignature("wrong-secret", BODY, sig, now)).toBe(false);
  });
});

describe("verifyWebhookSignature — legacy format", () => {
  it("verifies legacy sha256= signature", () => {
    const legacySig = "sha256=" + createHmac("sha256", SECRET).update(BODY).digest("hex");
    expect(verifyWebhookSignature(SECRET, BODY, legacySig)).toBe(true);
  });

  it("rejects tampered body in legacy format", () => {
    const legacySig = "sha256=" + createHmac("sha256", SECRET).update(BODY).digest("hex");
    expect(verifyWebhookSignature(SECRET, '{"tampered":true}', legacySig)).toBe(false);
  });
});

describe("extractWebhookTimestamp", () => {
  it("extracts timestamp from new format", () => {
    const sig = signWebhookPayload(SECRET, BODY, 1_700_000_000);
    expect(extractWebhookTimestamp(sig)).toBe(1_700_000_000);
  });

  it("returns null for legacy format", () => {
    expect(extractWebhookTimestamp("sha256=abc")).toBeNull();
  });
});
