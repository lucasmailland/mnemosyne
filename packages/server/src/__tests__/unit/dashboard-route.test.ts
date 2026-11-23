/**
 * Unit tests for GET /dashboard — P22 Status Dashboard (REQ-P22-01)
 *
 * Verifies that:
 *  - GET /dashboard returns 200 with Content-Type: text/html
 *  - HTML contains the required structural elements
 *  - Client-side auth gate uses sessionStorage (not localStorage or cookies)
 *  - Auto-refresh is present in the template (setInterval)
 *  - Encryption-not-configured message is present in the template
 */
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { mountDashboard } from "../../routes/dashboard.js";

function makeDashboardApp() {
  const app = new Hono();
  mountDashboard(app);
  return app;
}

describe("GET /dashboard — route registration and response (REQ-P22-01)", () => {
  it("returns 200", async () => {
    const app = makeDashboardApp();
    const res = await app.request("/dashboard");
    expect(res.status).toBe(200);
  });

  it("responds with text/html content-type", async () => {
    const app = makeDashboardApp();
    const res = await app.request("/dashboard");
    const ct = res.headers.get("content-type") ?? "";
    expect(ct).toMatch(/text\/html/);
  });

  it("HTML contains key gate div (REQ-P22-01 HTML contract)", async () => {
    const app = makeDashboardApp();
    const res = await app.request("/dashboard");
    const body = await res.text();
    expect(body).toContain('id="key-gate"');
  });

  it("HTML contains section-health container (REQ-P22-04)", async () => {
    const app = makeDashboardApp();
    const res = await app.request("/dashboard");
    const body = await res.text();
    expect(body).toContain('id="section-health"');
  });

  it("HTML contains section-observability container (REQ-P22-05)", async () => {
    const app = makeDashboardApp();
    const res = await app.request("/dashboard");
    const body = await res.text();
    expect(body).toContain('id="section-observability"');
  });

  it("HTML contains section-llm-config container (REQ-P22-06)", async () => {
    const app = makeDashboardApp();
    const res = await app.request("/dashboard");
    const body = await res.text();
    expect(body).toContain('id="section-llm-config"');
  });

  it("HTML contains section-api-keys container (REQ-P22-07)", async () => {
    const app = makeDashboardApp();
    const res = await app.request("/dashboard");
    const body = await res.text();
    expect(body).toContain('id="section-api-keys"');
  });
});

describe("GET /dashboard — auth gate uses sessionStorage (REQ-P22-02)", () => {
  it("HTML contains the sessionStorage key name", async () => {
    const app = makeDashboardApp();
    const res = await app.request("/dashboard");
    const body = await res.text();
    expect(body).toContain("mnemo_api_key");
  });

  it("HTML does NOT use localStorage (REQ-P22-02 storage constraint)", async () => {
    const app = makeDashboardApp();
    const res = await app.request("/dashboard");
    const body = await res.text();
    expect(body).not.toContain("localStorage");
  });

  it("HTML does NOT write document.cookie (REQ-P22-02 storage constraint)", async () => {
    const app = makeDashboardApp();
    const res = await app.request("/dashboard");
    const body = await res.text();
    expect(body).not.toContain("document.cookie");
  });
});

describe("GET /dashboard — health auto-refresh (REQ-P22-04)", () => {
  it("HTML contains setInterval for auto-refresh", async () => {
    const app = makeDashboardApp();
    const res = await app.request("/dashboard");
    const body = await res.text();
    expect(body).toContain("setInterval");
  });
});

describe("GET /dashboard — encryption-not-configured message (REQ-P22-06)", () => {
  it("HTML template contains 'Encryption not configured' string", async () => {
    const app = makeDashboardApp();
    const res = await app.request("/dashboard");
    const body = await res.text();
    expect(body).toContain("Encryption not configured");
  });

  it("HTML template references MNEMO_MASTER_KEY in the 501 message", async () => {
    const app = makeDashboardApp();
    const res = await app.request("/dashboard");
    const body = await res.text();
    expect(body).toContain("MNEMO_MASTER_KEY");
  });
});

describe("GET /dashboard — no external dependencies (cross-cutting constraint)", () => {
  it("HTML does not contain script src= attributes (no CDN scripts)", async () => {
    const app = makeDashboardApp();
    const res = await app.request("/dashboard");
    const body = await res.text();
    // Should have no external script tags (only inline <script>)
    expect(body).not.toMatch(/<script[^>]+src=/i);
  });

  it("HTML does not contain link href= stylesheet references", async () => {
    const app = makeDashboardApp();
    const res = await app.request("/dashboard");
    const body = await res.text();
    expect(body).not.toMatch(/<link[^>]+href=/i);
  });
});

describe("GET /dashboard — no auth required (REQ-P22-01)", () => {
  it("returns 200 with no Authorization header", async () => {
    const app = makeDashboardApp();
    const res = await app.request("/dashboard", { method: "GET" });
    expect(res.status).toBe(200);
  });
});
