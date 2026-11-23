import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { CURRENT_API_VERSION, createVersioningMiddleware, VERSION_CHANGES } from "../../versioning.js";

function app() {
  const a = new Hono();
  a.use("*", createVersioningMiddleware());
  a.get("/r", (c) => c.json({ id: "f1", worth: 0.5 })); // handler always emits the LATEST shape
  return a;
}

describe("api versioning (spec §35 lines 3905–3939)", () => {
  it("echoes the resolved version header (defaults to current when unpinned)", async () => {
    const res = await app().request("/r");
    expect(res.headers.get("Mnemosyne-Version")).toBe(CURRENT_API_VERSION);
  });

  it("applies a registered backward transform for an older pinned version", async () => {
    VERSION_CHANGES.push({
      date: "2099-01-01",
      description: "test: recall response includes worth scores",
      backward: (r: any) => { const { worth, ...rest } = r; return rest; },
      forward: (r: any) => r,
    });
    try {
      const res = await app().request("/r", { headers: { "Mnemosyne-Version": "2098-12-31" } });
      const body = await res.json();
      expect(body.worth).toBeUndefined(); // transformed back for the old client
      expect(body.id).toBe("f1");         // additive fields preserved
    } finally {
      VERSION_CHANGES.pop();
    }
  });

  it("does NOT transform when the client is pinned to the latest version", async () => {
    const res = await app().request("/r", { headers: { "Mnemosyne-Version": CURRENT_API_VERSION } });
    const body = await res.json();
    expect(body.worth).toBe(0.5);
  });
});
