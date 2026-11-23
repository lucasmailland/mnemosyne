/**
 * SEC-3: CORS must fail closed on credentials when MNEMO_CORS_ORIGINS is
 * unset. Previously the default was origin:"*" + credentials:true, which is
 * the exact spec-invalid combination Hono's cors() special-cases into
 * "reflect any Origin with Access-Control-Allow-Credentials: true" (CWE-942).
 */
import { describe, it, expect, afterEach, vi } from "vitest";

import { createApp } from "../../app.js";
import type { ServerDeps } from "../../deps.js";
import { makeMockCognitive } from "../helpers/mockCognitive.js";

function makeFakeDeps(): ServerDeps {
  const noopSpan = { setAttribute: () => {}, setStatus: () => {}, end: () => {} };
  return {
    core: {} as ServerDeps["core"],
    apiKeys: {
      async listActive() {
        return [];
      },
      async touch() {},
    },
    embedModel: "text-embedding-3-small",
    cognitive: makeMockCognitive(),
    telemetry: {
      startSpan: () => noopSpan,
      counter: () => {},
      histogram: () => {},
      gauge: () => {},
      shutdown: async () => {},
    },
  } as unknown as ServerDeps;
}

function makeApp() {
  return createApp({ deps: makeFakeDeps(), version: "test" });
}

describe("CORS (SEC-3)", () => {
  const origEnv = process.env.MNEMO_CORS_ORIGINS;
  afterEach(() => {
    if (origEnv === undefined) delete process.env.MNEMO_CORS_ORIGINS;
    else process.env.MNEMO_CORS_ORIGINS = origEnv;
  });

  it("with MNEMO_CORS_ORIGINS unset, does NOT reflect an arbitrary Origin with credentials", async () => {
    delete process.env.MNEMO_CORS_ORIGINS;
    const app = makeApp();
    const res = await app.request("/healthz", {
      headers: { origin: "https://evil.example" },
    });
    const acao = res.headers.get("access-control-allow-origin");
    const acac = res.headers.get("access-control-allow-credentials");
    // The spec-invalid combination (reflected Origin + credentials:true) must never appear.
    expect(acao === "https://evil.example" && acac === "true").toBe(false);
  });

  it("with MNEMO_CORS_ORIGINS unset, credentials are disabled entirely", async () => {
    delete process.env.MNEMO_CORS_ORIGINS;
    const app = makeApp();
    const res = await app.request("/healthz", {
      headers: { origin: "https://evil.example" },
    });
    expect(res.headers.get("access-control-allow-credentials")).not.toBe("true");
  });

  it("with MNEMO_CORS_ORIGINS set to an explicit origin, allows it with credentials", async () => {
    process.env.MNEMO_CORS_ORIGINS = "https://app.example";
    const app = makeApp();
    const res = await app.request("/healthz", {
      headers: { origin: "https://app.example" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe("https://app.example");
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("with MNEMO_CORS_ORIGINS set to an explicit origin, does NOT reflect a different origin", async () => {
    process.env.MNEMO_CORS_ORIGINS = "https://app.example";
    const app = makeApp();
    const res = await app.request("/healthz", {
      headers: { origin: "https://evil.example" },
    });
    expect(res.headers.get("access-control-allow-origin")).not.toBe("https://evil.example");
  });
});

describe("final review I1 — no wildcard CORS on the first-install routes", () => {
  it("bootstrap and setup answers are not readable cross-origin; other routes keep it", async () => {
    delete process.env.MNEMO_CORS_ORIGINS;
    const app = makeApp();
    for (const path of ["/bootstrap/status", "/setup/token", "/setup"]) {
      const res = await app.request(path, { headers: { origin: "https://evil.example" } });
      expect(res.headers.get("access-control-allow-origin"), path).toBeNull();
    }
    const health = await app.request("/healthz", { headers: { origin: "https://evil.example" } });
    expect(health.headers.get("access-control-allow-origin")).toBe("*");
  });
});
