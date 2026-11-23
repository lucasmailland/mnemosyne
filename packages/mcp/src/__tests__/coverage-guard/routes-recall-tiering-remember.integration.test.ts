/**
 * B4.1 — HTTP route coverage fill-in: recall tiering surface + POST /remember
 * (design.md "B4. Coverage fill-in", spec.md Requirement 13).
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

describe("POST /remember (B4.1)", () => {
  it("stores a new memory fact via the ergonomic /remember endpoint", async () => {
    const res = await surface.http("POST", "/remember", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ statement: "B4.1 remembered this via /remember." }),
    });
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.statement).toBe("B4.1 remembered this via /remember.");
  });
});

describe("recall tiering routes (B4.1)", () => {
  it("POST /recall/hot — hot-tier only recall (miss on a fresh workspace)", async () => {
    const res = await surface.http("POST", "/recall/hot", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ limit: 5 }),
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(Array.isArray(body.hits)).toBe(true);
    expect(typeof body.fromHotTier).toBe("boolean");
  });

  it("POST /recall/unified — memory + caller-supplied KB blend", async () => {
    await surface.http("POST", "/remember", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ statement: "B4.1 unified recall fixture fact." }),
    });
    const res = await surface.http("POST", "/recall/unified", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: "B4.1 unified recall fixture fact",
        kbHits: [{ id: "kb-1", content: "A KB chunk.", score: 0.5 }],
      }),
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(Array.isArray(body.hits)).toBe(true);
  });

  it("POST /recall/explain — per-hit scoring breakdown", async () => {
    await surface.http("POST", "/remember", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ statement: "B4.1 explain-recall fixture fact." }),
    });
    const res = await surface.http("POST", "/recall/explain", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "B4.1 explain-recall fixture fact" }),
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(Array.isArray(body.hits)).toBe(true);
    expect(typeof body.fromHotTier).toBe("boolean");
  });
});
