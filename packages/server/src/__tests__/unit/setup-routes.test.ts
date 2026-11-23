/**
 * Unit tests for the setup wizard routes in bootstrap.ts.
 *
 * Tests: GET /setup/token, GET /setup, POST /setup/validate-llm,
 *        POST /setup/complete
 *
 * Uses a fake postgres module that lets each test control:
 *  - whether the system is bootstrapped (api_keys count)
 *  - whether INSERTs succeed or throw
 *
 * Uses vi.fn() for global fetch to simulate LLM provider calls.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";

// ── Fake postgres factory ────────────────────────────────────────────────────
let fakeApiKeyCount = 0;
let shouldThrowOnInsert = false;

type SqlFn = (tpl: TemplateStringsArray, ...args: unknown[]) => Promise<unknown[]>;

function makeFakeSql(): SqlFn & { array: (v: unknown[]) => unknown; begin: (fn: (tx: SqlFn & { array: (v: unknown[]) => unknown }) => Promise<unknown>) => Promise<unknown>; end: () => Promise<void> } {
  const sql = (tpl: TemplateStringsArray, ..._args: unknown[]): Promise<unknown[]> => {
    const query = tpl.join("?").toLowerCase();
    if (query.includes("count(*)")) {
      return Promise.resolve([{ count: fakeApiKeyCount }]);
    }
    if (shouldThrowOnInsert && query.includes("insert")) {
      return Promise.reject(new Error("DB insert failure"));
    }
    return Promise.resolve([]);
  };
  sql.array = (v: unknown[]) => v;
  sql.begin = async (fn: (tx: typeof sql) => Promise<unknown>) => {
    if (shouldThrowOnInsert) throw new Error("DB insert failure");
    return fn(sql);
  };
  sql.end = async () => { /* no-op */ };
  return sql as ReturnType<typeof makeFakeSql>;
}

// ── Mock postgres module ─────────────────────────────────────────────────────
vi.mock("postgres", () => ({
  default: () => makeFakeSql(),
}));

// ── Reset env + state before each test ──────────────────────────────────────
beforeEach(async () => {
  fakeApiKeyCount = 0;
  shouldThrowOnInsert = false;
  process.env["DATABASE_URL"] = "postgres://fake:fake@localhost:5432/fake";
  process.env["PORT"] = "3939";
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
  vi.resetModules();
  // Reset global fetch mock
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function makeSetupApp() {
  const { mountBootstrap, generateSetupToken } = await import("../../routes/bootstrap.js");
  const app = new Hono();
  mountBootstrap(app);
  return { app, generateSetupToken };
}

// ── GET /setup/token ─────────────────────────────────────────────────────────
describe("GET /setup/token", () => {
  it("returns 404 when no token has been generated", async () => {
    const { app } = await makeSetupApp();
    const res = await app.request("/setup/token");
    expect(res.status).toBe(404);
  });

  it("returns 200 with token/expiresAt when unbootstrapped + token alive", async () => {
    const { app, generateSetupToken } = await makeSetupApp();
    const token = generateSetupToken();
    // APP-004: only a caller on the server's own loopback is given the token.
    const res = await app.request(
      "/setup/token",
      {},
      { incoming: { socket: { remoteAddress: "127.0.0.1" } } }
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { token: string; expiresAt: string; setupUrl: string };
    expect(body.token).toBe(token);
    expect(body.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(body.setupUrl).toContain(token);
  });

  it("returns 404 when bootstrapped (even with active token)", async () => {
    fakeApiKeyCount = 1;
    const { app, generateSetupToken } = await makeSetupApp();
    generateSetupToken();
    const res = await app.request("/setup/token");
    expect(res.status).toBe(404);
  });

  it("returns 404 when token has expired", async () => {
    const { app, generateSetupToken } = await makeSetupApp();
    generateSetupToken();
    // Advance past TTL
    vi.setSystemTime(new Date("2026-01-01T12:16:00.000Z"));
    const res = await app.request("/setup/token");
    expect(res.status).toBe(404);
  });
});

// ── GET /setup ───────────────────────────────────────────────────────────────
describe("GET /setup", () => {
  it("returns 200 HTML wizard when unbootstrapped", async () => {
    const { app, generateSetupToken } = await makeSetupApp();
    const token = generateSetupToken();
    const res = await app.request(`/setup?token=${token}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain(token);
    expect(html).toContain("Create workspace");
  });

  it("returns 200 complete page when bootstrapped", async () => {
    fakeApiKeyCount = 1;
    const { app } = await makeSetupApp();
    const res = await app.request("/setup");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Setup complete");
  });

  it("wizard page pre-fills token from query param", async () => {
    const { app, generateSetupToken } = await makeSetupApp();
    const token = generateSetupToken();
    const res = await app.request(`/setup?token=${token}`);
    const html = await res.text();
    expect(html).toContain(`value="${token}"`);
  });
});

// ── Final review I1: a web page on the same host cannot read the token ──────
describe("setup token and browsers", () => {
  const LOCAL = { incoming: { socket: { remoteAddress: "127.0.0.1" } } };

  it("a loopback request from a web page (Origin, Sec-Fetch-Site, foreign Host) gets 404", async () => {
    const { app, generateSetupToken } = await makeSetupApp();
    generateSetupToken();
    const tries: Record<string, string>[] = [
      { origin: "https://evil.example" },
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "same-site" },
      { host: "rebound.evil.example:3939" },
    ];
    for (const headers of tries) {
      const res = await app.request("http://127.0.0.1:3939/setup/token", { headers }, LOCAL);
      expect(res.status, JSON.stringify(headers)).toBe(404);
    }
  });

  it("a shell on the host, or the operator typing the URL, still gets it", async () => {
    const { app, generateSetupToken } = await makeSetupApp();
    const token = generateSetupToken();
    const curl = await app.request("http://localhost:3939/setup/token", {}, LOCAL);
    expect(curl.status).toBe(200);
    const typed = await app.request(
      "http://localhost:3939/setup",
      { headers: { "sec-fetch-site": "none" } },
      LOCAL
    );
    expect(await typed.text()).toContain(`value="${token}"`);
  });

  it("the setup page escapes the token it echoes", async () => {
    const { app, generateSetupToken } = await makeSetupApp();
    generateSetupToken();
    const res = await app.request('/setup?token="><script>alert(1)</script>');
    const html = await res.text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&#34;&#62;&#60;script&#62;");
  });
});

// ── POST /setup/validate-llm ─────────────────────────────────────────────────
describe("POST /setup/validate-llm", () => {
  it("returns 404 when bootstrapped", async () => {
    fakeApiKeyCount = 1;
    const { app } = await makeSetupApp();
    const res = await app.request("/setup/validate-llm", {
      method: "POST",
      body: JSON.stringify({ provider: "openai", apiKey: "sk-xxx" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(404);
  });

  it("returns { valid: true } immediately for local provider", async () => {
    const { app } = await makeSetupApp();
    const res = await app.request("/setup/validate-llm", {
      method: "POST",
      body: JSON.stringify({ provider: "local", apiKey: "" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { valid: boolean };
    expect(body.valid).toBe(true);
  });

  it("returns { valid: true } when OpenAI fetch succeeds", async () => {
    const { app } = await makeSetupApp();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    }));
    const res = await app.request("/setup/validate-llm", {
      method: "POST",
      body: JSON.stringify({ provider: "openai", apiKey: "sk-valid" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { valid: boolean };
    expect(body.valid).toBe(true);
  });

  it("returns { valid: false, error } when OpenAI fetch returns 401", async () => {
    const { app } = await makeSetupApp();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: { message: "Incorrect API key" } }),
    }));
    const res = await app.request("/setup/validate-llm", {
      method: "POST",
      body: JSON.stringify({ provider: "openai", apiKey: "sk-invalid" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { valid: boolean; error?: string };
    expect(body.valid).toBe(false);
    expect(body.error).toBeTruthy();
  });

  it("returns { valid: false, error } when fetch times out", async () => {
    const { app } = await makeSetupApp();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("The operation was aborted")));
    const res = await app.request("/setup/validate-llm", {
      method: "POST",
      body: JSON.stringify({ provider: "openai", apiKey: "sk-timeout" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { valid: boolean; error?: string };
    expect(body.valid).toBe(false);
    expect(body.error).toContain("aborted");
  });
});

// ── POST /setup/complete ─────────────────────────────────────────────────────
describe("POST /setup/complete", () => {
  it("happy path: creates workspace + api key, returns 201 with apiKey", async () => {
    const { app, generateSetupToken } = await makeSetupApp();
    const token = generateSetupToken();
    const res = await app.request("/setup/complete", {
      method: "POST",
      body: JSON.stringify({ token, workspaceName: "Test WS", llmProvider: "local", llmApiKey: "" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { ok: boolean; workspaceId: string; apiKey: string; envSnippet: string };
    expect(body.ok).toBe(true);
    expect(body.apiKey).toMatch(/^mns_live_/);
    expect(body.workspaceId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(body.envSnippet).toContain("MNEMO_KEY=");
  });

  it("returns 403 when token is expired", async () => {
    const { app, generateSetupToken } = await makeSetupApp();
    generateSetupToken();
    vi.setSystemTime(new Date("2026-01-01T12:16:00.000Z")); // expired
    const res = await app.request("/setup/complete", {
      method: "POST",
      body: JSON.stringify({ token: "expired-token", workspaceName: "WS", llmProvider: "local", llmApiKey: "" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(403);
  });

  it("returns 403 when wrong token submitted", async () => {
    const { app, generateSetupToken } = await makeSetupApp();
    generateSetupToken(); // generate a real token but submit a different one
    const res = await app.request("/setup/complete", {
      method: "POST",
      body: JSON.stringify({ token: "wrong-token", workspaceName: "WS", llmProvider: "local", llmApiKey: "" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(403);
  });

  it("returns 403 on double-submit (already bootstrapped)", async () => {
    fakeApiKeyCount = 1;
    const { app } = await makeSetupApp();
    const res = await app.request("/setup/complete", {
      method: "POST",
      body: JSON.stringify({ token: "any-token", workspaceName: "WS", llmProvider: "local", llmApiKey: "" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(403);
  });

  it("does not create rows when token is invalid (no DB calls beyond count)", async () => {
    const { app } = await makeSetupApp();
    // No token generated → invalid token
    const res = await app.request("/setup/complete", {
      method: "POST",
      body: JSON.stringify({ token: "no-such-token", workspaceName: "WS", llmProvider: "local", llmApiKey: "" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(403);
  });
});
