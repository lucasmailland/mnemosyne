/**
 * B4.1 — HTTP route coverage fill-in: workspace + global config surface
 * (design.md "B4. Coverage fill-in", spec.md Requirement 13).
 *
 * The live-surface harness (`startLiveSurface()`) boots the real app with no
 * `MNEMO_MASTER_KEY`, so `deps.workspaceConfigStore`/`llmConfigResolver` are
 * genuinely absent — every write route below deterministically takes its
 * real "encryption not configured" branch (501 `ENCRYPTION_REQUIRED`, or 404
 * `NOT_FOUND` for DELETE routes that check row-existence before the
 * encryption gate). That IS the real response shape for this configuration;
 * it is asserted on explicitly, not treated as an error to route around.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startLiveSurface, type LiveSurface } from "../harness/live-surface.js";

let surface: LiveSurface;

beforeAll(async () => {
  surface = await startLiveSurface();
}, 120_000);

afterAll(async () => {
  await surface.close();
});

describe("workspace config routes (B4.1)", () => {
  it("GET /config/llm — falls back to env source with no config store", async () => {
    const res = await surface.http("GET", "/config/llm");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { provider: string | null; source: string };
    expect(body.source).toBe("env");
  });

  it("PUT /config/llm — 501 ENCRYPTION_REQUIRED without MNEMO_MASTER_KEY", async () => {
    const res = await surface.http("PUT", "/config/llm", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "openai", apiKey: "sk-test" }),
    });
    expect(res.status).toBe(501);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("ENCRYPTION_REQUIRED");
  });

  it("DELETE /config/llm — 404 NOT_FOUND, no config store to hold a row", async () => {
    const res = await surface.http("DELETE", "/config/llm");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("NOT_FOUND");
  });

  it("GET /config/retention — falls back to env defaults", async () => {
    const res = await surface.http("GET", "/config/retention");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { source: string; internalDays: number };
    expect(body.source).toBe("env");
    expect(typeof body.internalDays).toBe("number");
  });

  it("PUT /config/retention — 501 ENCRYPTION_REQUIRED without MNEMO_MASTER_KEY", async () => {
    const res = await surface.http("PUT", "/config/retention", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ internalDays: 30, confidentialDays: 90, restrictedDays: 365 }),
    });
    expect(res.status).toBe(501);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("ENCRYPTION_REQUIRED");
  });

  it("DELETE /config/retention — 501 ENCRYPTION_REQUIRED (checked before row lookup)", async () => {
    const res = await surface.http("DELETE", "/config/retention");
    expect(res.status).toBe(501);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("ENCRYPTION_REQUIRED");
  });
});

describe("global admin config routes (B4.1)", () => {
  it("GET /admin/config/llm — falls back to env source with no config store", async () => {
    const res = await surface.http("GET", "/admin/config/llm");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { provider: string | null; source: string };
    expect(body.source).toBe("env");
  });

  it("PUT /admin/config/llm — 501 ENCRYPTION_REQUIRED without MNEMO_MASTER_KEY", async () => {
    const res = await surface.http("PUT", "/admin/config/llm", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "openai", apiKey: "sk-test" }),
    });
    expect(res.status).toBe(501);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("ENCRYPTION_REQUIRED");
  });

  it("GET /admin/config/retention — falls back to env defaults", async () => {
    const res = await surface.http("GET", "/admin/config/retention");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { source: string; internalDays: number };
    expect(body.source).toBe("env");
  });

  it("PUT /admin/config/retention — 501 ENCRYPTION_REQUIRED without MNEMO_MASTER_KEY", async () => {
    const res = await surface.http("PUT", "/admin/config/retention", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ internalDays: 30, confidentialDays: 90, restrictedDays: 365 }),
    });
    expect(res.status).toBe(501);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("ENCRYPTION_REQUIRED");
  });

  it("DELETE /admin/config/retention — 501 ENCRYPTION_REQUIRED (no config store)", async () => {
    const res = await surface.http("DELETE", "/admin/config/retention");
    expect(res.status).toBe(501);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("ENCRYPTION_REQUIRED");
  });
});
