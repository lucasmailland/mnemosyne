/**
 * B4.1 — HTTP route coverage fill-in: graph surface
 * (design.md "B4. Coverage fill-in", spec.md Requirement 13).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startLiveSurface, type LiveSurface } from "../harness/live-surface.js";

let surface: LiveSurface;
let entityId: string;

beforeAll(async () => {
  surface = await startLiveSurface();
  const res = await surface.http("POST", "/entities", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "B4.1 Graph Entity", kind: "concept" }),
  });
  const body = (await res.json()) as { id: string };
  entityId = body.id;
}, 120_000);

afterAll(async () => {
  await surface.close();
});

describe("graph routes (B4.1)", () => {
  it("GET /graph — full workspace graph snapshot", async () => {
    const res = await surface.http("GET", "/graph");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { nodes: unknown[]; edges: unknown[]; meta: unknown };
    expect(Array.isArray(body.nodes)).toBe(true);
    expect(Array.isArray(body.edges)).toBe(true);
  });

  it("GET /graph?focus=<entityId> — focused 1-hop view", async () => {
    const res = await surface.http("GET", `/graph?focus=${entityId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { nodes: Array<{ id: string }> };
    expect(body.nodes.some((n) => n.id === entityId)).toBe(true);
  });

  it("GET /entities/:id/graph — alias for GET /graph?focus=:id", async () => {
    const res = await surface.http("GET", `/entities/${entityId}/graph`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { nodes: Array<{ id: string }> };
    expect(body.nodes.some((n) => n.id === entityId)).toBe(true);
  });

  it("GET /graph/traverse — BFS from a root node", async () => {
    const res = await surface.http("GET", `/graph/traverse?root=${entityId}&maxHops=2`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hits: unknown[] };
    expect(Array.isArray(body.hits)).toBe(true);
  });

  it("GET /graph/path — 400 without required from/to params (real validation)", async () => {
    const res = await surface.http("GET", "/graph/path");
    expect(res.status).toBe(400);
  });

  it("GET /graph/path — shortest path between two (likely unreachable) nodes", async () => {
    const res = await surface.http("GET", `/graph/path?from=${entityId}&to=nonexistent-node`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: unknown[]; edges: unknown[] };
    expect(Array.isArray(body.path)).toBe(true);
  });

  it("POST /admin/graph/semantic-backfill — recompute kNN semantic-neighbor edges", async () => {
    const res = await surface.http("POST", "/admin/graph/semantic-backfill", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { edgesWritten: number };
    expect(typeof body.edgesWritten).toBe("number");
  });
});
