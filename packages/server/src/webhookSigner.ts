import { createHmac, timingSafeEqual } from "node:crypto";

const REPLAY_WINDOW_SECONDS = 300;

/**
 * Sign a webhook payload using Stripe-style format:
 *   t=<unix_seconds>,v1=<HMAC-SHA256(secret, t + "." + body)>
 *
 * The timestamp prevents replay attacks — receivers must check |now - t| <= 300s.
 */
export function signWebhookPayload(
  secret: string,
  body: string,
  timestampSeconds?: number,
): string {
  const t = timestampSeconds ?? Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", secret).update(`${t}.${body}`, "utf8").digest("hex");
  return `t=${t},v1=${sig}`;
}

/**
 * Verify a webhook signature. Accepts both new and legacy formats.
 *
 * New format: "t=<ts>,v1=<sig>" — verified with replay window check.
 * Legacy format: "sha256=<hex>" — accepted during deprecation window (no replay check).
 *
 * @param nowSeconds - Current time in seconds (injectable for testing).
 */
export function verifyWebhookSignature(
  secret: string,
  body: string,
  signature: string,
  nowSeconds?: number,
): boolean {
  if (signature.startsWith("t=")) {
    const parts = signature.split(",");
    const tPart = parts.find((p) => p.startsWith("t="));
    const v1Part = parts.find((p) => p.startsWith("v1="));
    if (!tPart || !v1Part) return false;

    const t = parseInt(tPart.slice(2), 10);
    if (!Number.isFinite(t)) return false;

    const now = nowSeconds ?? Math.floor(Date.now() / 1000);
    if (Math.abs(now - t) > REPLAY_WINDOW_SECONDS) return false;

    const expected = createHmac("sha256", secret).update(`${t}.${body}`, "utf8").digest("hex");
    const v1 = v1Part.slice(3);
    if (expected.length !== v1.length) return false;
    return timingSafeEqual(Buffer.from(expected), Buffer.from(v1));
  }

  if (signature.startsWith("sha256=")) {
    const expected = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
    if (expected.length !== signature.length) return false;
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  }

  return false;
}

/**
 * Build the dual signature header object required by the spec.
 *
 * The spec mandates `Mnemosyne-Signature`; existing receivers use the legacy
 * `X-Mnemosyne-Signature`. Both headers carry the same HMAC value so that
 * spec-conformant and legacy receivers work simultaneously.
 */
export function buildSignatureHeaders(signature: string): Record<string, string> {
  return {
    "Mnemosyne-Signature": signature,
    "X-Mnemosyne-Signature": signature, // legacy alias — keep until receivers migrate
  };
}

/**
 * Extract the timestamp from a new-format signature header.
 * Returns null for legacy signatures or invalid formats.
 */
export function extractWebhookTimestamp(signature: string): number | null {
  if (!signature.startsWith("t=")) return null;
  const tPart = signature.split(",").find((p) => p.startsWith("t="));
  if (!tPart) return null;
  const t = parseInt(tPart.slice(2), 10);
  return Number.isFinite(t) ? t : null;
}
