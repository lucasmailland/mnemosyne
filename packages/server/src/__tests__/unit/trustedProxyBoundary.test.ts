/**
 * SEC-7.4 — Trusted-proxy boundary for x-mnemo-client-cert header.
 *
 * When MNEMO_TRUSTED_PROXY_IP is configured, the auth middleware must
 * silently ignore x-mnemo-client-cert from any source that does not match
 * the trusted proxy IP, preventing header-spoofing by untrusted callers.
 *
 * When MNEMO_TRUSTED_PROXY_IP is not set the header is trusted from any
 * source (backward-compatible behaviour for dev / single-node deployments).
 *
 * See docs/architecture/MTLS_BOUNDARY.md for the full trust model.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { generateKeyPairSync } from "node:crypto";

import { createV3AuthMiddleware } from "../../middleware/auth.js";
import type { AuthAdapter, AuthContext, RawCredentials } from "../../middleware/auth.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const TRUSTED_IP = "10.0.0.1";
const UNTRUSTED_IP = "8.8.8.8";

/** A minimal valid DER-encoded client certificate (public key only). */
const { publicKey } = generateKeyPairSync("ed25519");
const CERT_DER = new Uint8Array(
  publicKey.export({ format: "der", type: "spki" })
);
const CERT_B64URL = Buffer.from(CERT_DER).toString("base64url");

/**
 * Build a stub AuthAdapter.
 *
 * - If `requiresCert` is true, it only succeeds when `clientCert` is present.
 * - Otherwise it always succeeds (simulates API-key fallback).
 */
function makeAdapter(requiresCert: boolean): AuthAdapter {
  return {
    id: "stub",
    async authenticate(creds: RawCredentials): Promise<ReturnType<AuthAdapter["authenticate"]>> {
      if (requiresCert) {
        if (!creds.clientCert) {
          return { ok: false, code: "UNAUTHORIZED", reason: "no cert" };
        }
        return {
          ok: true,
          context: stubCtx(),
        };
      }
      // simulates API-key path — always accepts (cert is ignored / not required)
      return {
        ok: true,
        context: stubCtx(),
      };
    },
    async authorize() {},
    async healthCheck() {
      return { status: "healthy" };
    },
  };
}

function stubCtx(): AuthContext {
  return {
    workspaceId: "ws-test",
    actorId: "actor-test",
    actorType: "federation",
    scopes: ["memory:read"],
  };
}

function buildApp(adapter: AuthAdapter) {
  const app = new Hono();
  app.use("*", createV3AuthMiddleware(adapter));
  app.get("/probe", (c) => c.json({ ok: true }));
  return app;
}

function makeReq(fromIp: string, hasCert: boolean, hasFallbackKey: boolean) {
  const headers: Record<string, string> = {};
  headers["x-forwarded-for"] = fromIp;
  if (hasCert) {
    headers["x-mnemo-client-cert"] = CERT_B64URL;
  }
  if (hasFallbackKey) {
    // A real-format bearer token long enough to pass MIN_TOKEN_LENGTH
    headers["authorization"] = "Bearer mns_live_aaaaaaaaaaaaaaaaaaaaa";
  }
  return { headers };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("trusted-proxy boundary — MNEMO_TRUSTED_PROXY_IP set", () => {
  beforeEach(() => {
    process.env["MNEMO_TRUSTED_PROXY_IP"] = TRUSTED_IP;
    // Force the module-level constant to reload by clearing module cache
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env["MNEMO_TRUSTED_PROXY_IP"];
    vi.resetModules();
  });

  it("trusts x-mnemo-client-cert from the configured trusted proxy IP", async () => {
    // Re-import after env change to pick up new TRUSTED_PROXY_IP value
    const { createV3AuthMiddleware: freshMw } = await import("../../middleware/auth.js");
    const adapter = makeAdapter(true /* requiresCert */);
    const app = new Hono();
    app.use("*", freshMw(adapter));
    app.get("/probe", (c) => c.json({ ok: true }));

    const res = await app.request("/probe", makeReq(TRUSTED_IP, true, false));
    expect(res.status).toBe(200);
  });

  it("ignores x-mnemo-client-cert from an untrusted IP — cert-only adapter gets 401", async () => {
    const { createV3AuthMiddleware: freshMw } = await import("../../middleware/auth.js");
    const adapter = makeAdapter(true /* requiresCert */);
    const app = new Hono();
    app.use("*", freshMw(adapter));
    app.get("/probe", (c) => c.json({ ok: true }));

    // Request comes from UNTRUSTED_IP with a cert — cert must be stripped
    const res = await app.request("/probe", makeReq(UNTRUSTED_IP, true, false));
    // The adapter gets no clientCert so authentication fails
    expect(res.status).toBe(401);
  });

  it("falls through to API key when cert is stripped from untrusted IP", async () => {
    const { createV3AuthMiddleware: freshMw } = await import("../../middleware/auth.js");
    // Adapter does NOT require cert — succeeds on any credential (API key)
    const adapter = makeAdapter(false /* requiresCert */);
    const app = new Hono();
    app.use("*", freshMw(adapter));
    app.get("/probe", (c) => c.json({ ok: true }));

    // Untrusted IP sends cert + fallback bearer key; cert is ignored, bearer succeeds
    const res = await app.request("/probe", makeReq(UNTRUSTED_IP, true, true));
    expect(res.status).toBe(200);
  });
});

describe("trusted-proxy boundary — MNEMO_TRUSTED_PROXY_IP not set (backward compat)", () => {
  beforeEach(() => {
    delete process.env["MNEMO_TRUSTED_PROXY_IP"];
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("trusts x-mnemo-client-cert from any source when env var is absent", async () => {
    const { createV3AuthMiddleware: freshMw } = await import("../../middleware/auth.js");
    const adapter = makeAdapter(true /* requiresCert */);
    const app = new Hono();
    app.use("*", freshMw(adapter));
    app.get("/probe", (c) => c.json({ ok: true }));

    // No trusted proxy configured — any source should be accepted
    const res = await app.request("/probe", makeReq(UNTRUSTED_IP, true, false));
    expect(res.status).toBe(200);
  });
});
