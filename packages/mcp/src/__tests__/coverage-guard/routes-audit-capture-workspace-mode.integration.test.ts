/**
 * B4.1 — HTTP route coverage fill-in: audit log, passive capture, and
 * workspace learning/production mode (design.md "B4. Coverage fill-in",
 * spec.md Requirement 13).
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

async function json(res: Response): Promise<any> {
  return res.json();
}

describe("GET /audit (B4.1)", () => {
  it("undo-log feed reflects a real forgotten fact", async () => {
    const fact = await json(
      await surface.http("POST", "/remember", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ statement: "Will be forgotten for the audit log." }),
      })
    );
    await surface.http("DELETE", `/facts/${fact.id}`);

    const res = await surface.http("GET", "/audit");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.available).toBe(true);
    expect(body.items.some((e: any) => e.factId === fact.id)).toBe(true);
  });
});

describe("POST /capture (B4.1)", () => {
  it("regex-heuristic extraction (no LLM adapter wired)", async () => {
    const res = await surface.http("POST", "/capture", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: "We switched to Postgres because it has better JSON support.",
        source: "b4.1-test",
      }),
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(typeof body.extracted).toBe("number");
    expect(typeof body.skipped).toBe("number");
  });
});

describe("workspace-mode routes (B4.1)", () => {
  it("GET /workspace-mode — learning defaults for a fresh workspace", async () => {
    const res = await surface.http("GET", "/workspace-mode");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.mode).toBe("learning");
  });

  it("PUT /workspace-mode — change mode and promote-at threshold", async () => {
    const res = await surface.http("PUT", "/workspace-mode", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "production", promoteAt: 100 }),
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.mode).toBe("production");
    expect(body.promoteAt).toBe(100);
  });
});
