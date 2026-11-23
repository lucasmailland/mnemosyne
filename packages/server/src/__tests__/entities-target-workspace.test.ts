/**
 * POST /entities — targetWorkspaceId cross-workspace write support (P57
 * slice 2a). See decisions-target-workspace.test.ts for the shared rationale
 * — every 201 body is parsed and asserted, not just schema presence.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, it, expect, vi } from "vitest";

import type { AuthVariables } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import { toErrorBody } from "../errors.js";
import { mountEntities } from "../routes/entities.js";

const KEY_WS_ID = "00000000-0000-0000-0000-dd0000000001";
const TARGET_WS_ID = "00000000-0000-0000-0000-dd0000000002";
const USER_ID = "user-entities-target-ws-test-001";

function makeFakeSql(role: string | null) {
  const tx = (strings: TemplateStringsArray) => {
    const text = strings.join("?");
    if (text.includes("set_config")) return Promise.resolve([]);
    if (text.includes("mnemo_workspace_member")) {
      return Promise.resolve(role ? [{ role }] : []);
    }
    return Promise.resolve([]);
  };
  return {
    begin: async (fn: (tx: typeof tx) => Promise<unknown>) => fn(tx),
  } as unknown as ServerDeps["metricsPgClient"];
}

function makeApp(opts: {
  createEntity: ReturnType<typeof vi.fn>;
  sqlRole: string | null;
  userId?: string | null;
}) {
  const app = new OpenAPIHono<{ Variables: AuthVariables }>();
  app.use("*", async (c, next) => {
    c.set("workspaceId", KEY_WS_ID);
    c.set("apiKeyPrefix", "mns_live_");
    c.set("actorId", "test-key-id");
    c.set("actorType", "user");
    c.set("scopes", ["memory:write"] as ReadonlyArray<string>);
    c.set("userId", "userId" in opts ? opts.userId : USER_ID);
    await next();
  });

  const fakeDeps = {
    storage: {
      createEntity: opts.createEntity,
      countEntityMentions: vi.fn().mockResolvedValue({}),
    } as unknown,
    metricsPgClient: makeFakeSql(opts.sqlRole),
  } as unknown as ServerDeps;

  mountEntities(app, fakeDeps);
  app.onError((err, c) => {
    const { status, body } = toErrorBody(err);
    return c.json(body, status as Parameters<typeof c.json>[1]);
  });
  return app.request.bind(app);
}

const baseEntity = {
  id: "ment_test1",
  name: "Ada Lovelace",
  kind: "person" as const,
  aliases: [],
  canonicalId: null,
  description: null,
  sensitivity: "internal" as const,
  metadata: {},
  firstSeenAt: new Date("2026-08-01T00:00:00.000Z"),
  lastSeenAt: new Date("2026-08-01T00:00:00.000Z"),
  mentionCount: 1,
  // P120: the response schema now projects the bitemporal interval.
  validFrom: new Date("2026-01-01T00:00:00.000Z"),
  validTo: null,
  createdAt: new Date("2026-08-01T00:00:00.000Z"),
  updatedAt: new Date("2026-08-01T00:00:00.000Z"),
};

describe("POST /entities — targetWorkspaceId", () => {
  it("write-role member targeting a different workspace → 201, response workspaceId is the target, storage receives the target workspace", async () => {
    const createEntity = vi.fn().mockResolvedValue({ ...baseEntity, workspaceId: TARGET_WS_ID });
    const request = makeApp({ createEntity, sqlRole: "admin" });

    const res = await request("/entities", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Ada Lovelace",
        kind: "person",
        aliases: [],
        targetWorkspaceId: TARGET_WS_ID,
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { workspaceId: string };
    expect(body.workspaceId).toBe(TARGET_WS_ID);
    expect(createEntity).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: TARGET_WS_ID })
    );
  });

  it("omitting targetWorkspaceId → 201 in the key's own workspace, byte-identical to pre-change", async () => {
    const createEntity = vi.fn().mockResolvedValue({ ...baseEntity, workspaceId: KEY_WS_ID });
    const request = makeApp({ createEntity, sqlRole: null });

    const res = await request("/entities", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Ada Lovelace", kind: "person", aliases: [] }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { workspaceId: string };
    expect(body.workspaceId).toBe(KEY_WS_ID);
    expect(createEntity).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: KEY_WS_ID }));
  });

  it("non-member → 403 forbidden, flat shape, zero writes", async () => {
    const createEntity = vi.fn();
    const request = makeApp({ createEntity, sqlRole: null });

    const res = await request("/entities", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Should not land",
        kind: "person",
        aliases: [],
        targetWorkspaceId: TARGET_WS_ID,
      }),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; message: string };
    expect(body).toEqual({
      error: "forbidden",
      message: "User is not a write member of the target workspace",
    });
    expect(createEntity).not.toHaveBeenCalled();
  });

  it("read-role member → 403, identical body to non-member, zero writes", async () => {
    const createEntity = vi.fn();
    const request = makeApp({ createEntity, sqlRole: "read" });

    const res = await request("/entities", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Should not land",
        kind: "person",
        aliases: [],
        targetWorkspaceId: TARGET_WS_ID,
      }),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; message: string };
    expect(body).toEqual({
      error: "forbidden",
      message: "User is not a write member of the target workspace",
    });
    expect(createEntity).not.toHaveBeenCalled();
  });

  it("non-user-bound key → 403 'requires a user-bound key', zero writes", async () => {
    const createEntity = vi.fn();
    const request = makeApp({ createEntity, sqlRole: "write", userId: null });

    const res = await request("/entities", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Should not land",
        kind: "person",
        aliases: [],
        targetWorkspaceId: TARGET_WS_ID,
      }),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; message: string };
    expect(body).toEqual({
      error: "forbidden",
      message: "targetWorkspaceId requires a user-bound key (mk_user_* or mk_live_* with user_id)",
    });
    expect(createEntity).not.toHaveBeenCalled();
  });
});
