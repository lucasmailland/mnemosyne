/**
 * GET /conflicts and POST /conflicts/{id}/resolve honor the read ceiling.
 *
 * A pair whose either fact sits above the caller's ceiling is not listed, and
 * resolving it answers 404 (S6: not 403, never confirm the row exists). A
 * caller whose ceiling covers both facts sees and resolves the pair.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthVariables } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import { toErrorBody } from "../../errors.js";
import { mountConflicts } from "../../routes/conflicts.js";

const WS = "00000000-0000-0000-0000-0000000c0e11";

const relation = {
  id: "rel_1",
  workspaceId: WS,
  sourceId: "fact_open",
  sourceType: "fact",
  targetId: "fact_restricted",
  targetType: "fact",
  verb: "conflicts_with",
  weight: 1,
  confidence: 0.9,
  validTo: null,
};

function fact(id: string, sensitivity: string) {
  return {
    id,
    workspaceId: WS,
    subject: "deploys",
    statement: `statement ${id}`,
    worth: 0.5,
    validFrom: new Date("2026-06-01T00:00:00.000Z"),
    validTo: undefined,
    sensitivity,
  };
}

function makeApp(maxSensitivity?: string) {
  const resolveConflict = vi.fn().mockResolvedValue({ mergedFactId: null });
  const storage = {
    getRelations: vi.fn().mockResolvedValue([relation]),
    getFact: vi.fn(async (id: string) =>
      id === "fact_restricted" ? fact(id, "restricted") : fact(id, "public")
    ),
    resolveConflict,
    // Mirrors the adapters: the pairs of `getRelations` whose facts the ceiling admits.
    countOpenConflicts: vi.fn(async ({ maxSensitivity }: { maxSensitivity?: string }) =>
      maxSensitivity === "restricted" || maxSensitivity === undefined ? 1 : 0
    ),
  };
  const app = new OpenAPIHono<{ Variables: AuthVariables }>();
  app.use("*", async (c, next) => {
    c.set("workspaceId", WS);
    c.set("actorId", "key-1");
    c.set("scopes", [] as ReadonlyArray<string>);
    if (maxSensitivity !== undefined) c.set("maxSensitivity" as never, maxSensitivity);
    await next();
  });
  mountConflicts(app, { storage } as unknown as ServerDeps);
  app.onError((err, c) => {
    const { status, body } = toErrorBody(err);
    return c.json(body, status as Parameters<typeof c.json>[1]);
  });
  return { app, resolveConflict, storage };
}

const resolve = (app: OpenAPIHono<{ Variables: AuthVariables }>) =>
  app.request("/conflicts/rel_1/resolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "keep_both" }),
  });

describe("conflicts honor the read ceiling", () => {
  const saved = process.env.MNEMO_SENSITIVITY_CEILING;
  beforeEach(() => {
    // The process-wide ceiling covers every tier; only a key's grant lowers it.
    process.env.MNEMO_SENSITIVITY_CEILING = "restricted";
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.MNEMO_SENSITIVITY_CEILING;
    else process.env.MNEMO_SENSITIVITY_CEILING = saved;
  });

  it("a limited key does not see a pair with a fact above its ceiling", async () => {
    const { app } = makeApp("internal");
    const res = await app.request("/conflicts");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pairs: [], total: 0 });
  });

  it("a limited key resolving that pair gets 404 and nothing is written", async () => {
    const { app, resolveConflict } = makeApp("internal");
    const res = await resolve(app);
    expect(res.status).toBe(404);
    expect(resolveConflict).not.toHaveBeenCalled();
  });

  it("an admin (no per-key grant) sees the pair", async () => {
    const { app } = makeApp();
    const res = await app.request("/conflicts");
    const body = (await res.json()) as { pairs: Array<{ relationId: string }>; total: number };
    expect(body.pairs.map((p) => p.relationId)).toEqual(["rel_1"]);
    expect(body.total).toBe(1);
  });

  it("total counts every pair the caller can see, past `limit`, and none it cannot", async () => {
    const { app, storage } = makeApp("internal");
    storage.getRelations.mockResolvedValue([
      relation,
      ...["a", "b", "c"].map((n) => ({ ...relation, id: `rel_${n}`, targetId: `fact_${n}` })),
    ]);
    const res = await app.request("/conflicts?limit=2");
    const body = (await res.json()) as { pairs: Array<{ relationId: string }>; total: number };
    expect(body.pairs.map((p) => p.relationId)).toEqual(["rel_a", "rel_b"]);
    // One COUNT under the caller's ceiling, not a read of every pair.
    storage.countOpenConflicts.mockResolvedValueOnce(3);
    const counted = (await (await app.request("/conflicts?limit=2")).json()) as { total: number };
    expect(counted.total).toBe(3);
    expect(storage.countOpenConflicts).toHaveBeenLastCalledWith({
      workspaceId: WS,
      maxSensitivity: "internal",
    });
    expect(storage.getFact.mock.calls.length).toBeLessThanOrEqual(2 * 2 * 3);
  });

  it("an admin resolves the pair", async () => {
    const { app, resolveConflict } = makeApp();
    const res = await resolve(app);
    expect(res.status).toBe(200);
    expect(resolveConflict).toHaveBeenCalledOnce();
  });
});
