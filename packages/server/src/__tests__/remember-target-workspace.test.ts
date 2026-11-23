/**
 * POST /remember — targetWorkspaceId post-extraction regression coverage
 * (P57 slice 1). `remember.ts`'s inline membership-check block was replaced
 * by a single call to `resolveTargetWorkspace` (`workspace-target.ts`);
 * these tests assert the route's outward behaviour is byte-identical to
 * before the extraction: the same 4 403 bodies, `scope: "personal"` still
 * overriding `targetWorkspaceId`, and `scopeOwner: "workspace:<target>"`
 * still being accepted.
 */
import { describe, it, expect, vi } from "vitest";
import bcrypt from "bcrypt";
import { BCRYPT_COST } from "../auth.js";
import type { ApiKeyLookup } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import { mountRemember } from "../routes/remember.js";
import { buildMountHarness } from "./_mountHarness.js";

const PLAINTEXT_KEY = "mns_live_remembertargetwstest01";
const KEY_WS_ID = "00000000-0000-0000-0000-bb0000000001";
const TARGET_WS_ID = "00000000-0000-0000-0000-bb0000000002";
const PERSONAL_WS_ID = "00000000-0000-0000-0000-bb0000000003";
const USER_ID = "user-remember-target-ws-test-001";
const PERSONAL_TENANT_ID = "tenant-remember-target-ws-test-001";

async function makeKeyLookup(opts: { userId?: string | null } = {}): Promise<ApiKeyLookup> {
  const keyHash = await bcrypt.hash(PLAINTEXT_KEY, BCRYPT_COST);
  // NOTE: "userId" in opts (not `opts.userId ?? USER_ID`) — callers must be
  // able to explicitly pass `userId: null` to exercise the non-user-bound-key
  // path without it silently falling back to the default USER_ID.
  const userId = "userId" in opts ? opts.userId : USER_ID;
  return {
    listActive: async () => [
      {
        id: "key-remember-target-ws",
        keyHash,
        workspaceId: KEY_WS_ID,
        scopes: ["memory:write"],
        userId,
      },
    ],
    findByLookupHash: undefined,
    setLookupHash: undefined,
    touch: async () => {},
  } as unknown as ApiKeyLookup;
}

/** Fake postgres.Sql for the membership check + (when exercised) personal-workspace lookup. */
function makeFakeSql(opts: {
  role?: string | null;
  personalTenantId?: string | null;
  personalWsId?: string | null;
}) {
  const tx = (strings: TemplateStringsArray) => {
    const text = strings.join("?");
    if (text.includes("set_config")) return Promise.resolve([]);
    if (text.includes("mnemo_workspace_member")) {
      return Promise.resolve(opts.role ? [{ role: opts.role }] : []);
    }
    if (text.includes("mnemo_user")) {
      return Promise.resolve(
        opts.personalTenantId ? [{ personal_tenant_id: opts.personalTenantId }] : []
      );
    }
    if (text.includes("mnemo_workspace")) {
      return Promise.resolve(opts.personalWsId ? [{ id: opts.personalWsId }] : []);
    }
    return Promise.resolve([]);
  };
  return {
    begin: async (fn: (tx: typeof tx) => Promise<unknown>) => fn(tx),
  } as unknown as ServerDeps["metricsPgClient"];
}

const authed = () => ({
  authorization: `Bearer ${PLAINTEXT_KEY}`,
  "content-type": "application/json",
});

describe("POST /remember — targetWorkspaceId (post-extraction)", () => {
  it("write-role member targeting a different workspace → 201 in the target workspace", async () => {
    const remember = vi.fn(async () => ({ id: "fact_1", kind: "fact", staged: false }));
    const deps = {
      apiKeys: await makeKeyLookup(),
      cognitive: { remember },
      metricsPgClient: makeFakeSql({ role: "write" }),
    } as unknown as ServerDeps;
    const app = buildMountHarness(deps, [mountRemember]);

    const res = await app.request("/remember", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ statement: "cross-workspace fact", targetWorkspaceId: TARGET_WS_ID }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { workspaceId: string };
    expect(body.workspaceId).toBe(TARGET_WS_ID);
    expect(remember).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: TARGET_WS_ID }),
      expect.anything()
    );
  });

  it("omitting targetWorkspaceId → 201 in the key's own workspace, byte-identical to pre-change", async () => {
    const remember = vi.fn(async () => ({ id: "fact_2", kind: "fact", staged: false }));
    const deps = {
      apiKeys: await makeKeyLookup(),
      cognitive: { remember },
      metricsPgClient: makeFakeSql({}),
    } as unknown as ServerDeps;
    const app = buildMountHarness(deps, [mountRemember]);

    const res = await app.request("/remember", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ statement: "same-workspace fact" }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { workspaceId: string };
    expect(body.workspaceId).toBe(KEY_WS_ID);
    expect(remember).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: KEY_WS_ID }),
      expect.anything()
    );
  });

  it("non-member → 403 forbidden, matching pre-extraction message, zero writes", async () => {
    const remember = vi.fn();
    const deps = {
      apiKeys: await makeKeyLookup(),
      cognitive: { remember },
      metricsPgClient: makeFakeSql({ role: null }),
    } as unknown as ServerDeps;
    const app = buildMountHarness(deps, [mountRemember]);

    const res = await app.request("/remember", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ statement: "should not land", targetWorkspaceId: TARGET_WS_ID }),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; message: string };
    expect(body).toEqual({
      error: "forbidden",
      message: "User is not a write member of the target workspace",
    });
    expect(remember).not.toHaveBeenCalled();
  });

  it("read-role member → 403, identical body to the non-member case, zero writes", async () => {
    const remember = vi.fn();
    const deps = {
      apiKeys: await makeKeyLookup(),
      cognitive: { remember },
      metricsPgClient: makeFakeSql({ role: "read" }),
    } as unknown as ServerDeps;
    const app = buildMountHarness(deps, [mountRemember]);

    const res = await app.request("/remember", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ statement: "should not land", targetWorkspaceId: TARGET_WS_ID }),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; message: string };
    expect(body).toEqual({
      error: "forbidden",
      message: "User is not a write member of the target workspace",
    });
    expect(remember).not.toHaveBeenCalled();
  });

  it("non-user-bound key → 403 'requires a user-bound key', zero writes", async () => {
    const remember = vi.fn();
    const deps = {
      apiKeys: await makeKeyLookup({ userId: null }),
      cognitive: { remember },
      metricsPgClient: makeFakeSql({ role: "write" }),
    } as unknown as ServerDeps;
    const app = buildMountHarness(deps, [mountRemember]);

    const res = await app.request("/remember", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ statement: "should not land", targetWorkspaceId: TARGET_WS_ID }),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; message: string };
    expect(body).toEqual({
      error: "forbidden",
      message: "targetWorkspaceId requires a user-bound key (mk_user_* or mk_live_* with user_id)",
    });
    expect(remember).not.toHaveBeenCalled();
  });

  it("scope: 'personal' still wins over targetWorkspaceId (overrides after the helper resolves)", async () => {
    const remember = vi.fn(async () => ({ id: "fact_3", kind: "fact", staged: false }));
    const deps = {
      apiKeys: await makeKeyLookup(),
      cognitive: { remember },
      metricsPgClient: makeFakeSql({
        role: "write",
        personalTenantId: PERSONAL_TENANT_ID,
        personalWsId: PERSONAL_WS_ID,
      }),
    } as unknown as ServerDeps;
    const app = buildMountHarness(deps, [mountRemember]);

    const res = await app.request("/remember", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({
        statement: "personal beats target",
        targetWorkspaceId: TARGET_WS_ID,
        scope: "personal",
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { workspaceId: string };
    expect(body.workspaceId).toBe(PERSONAL_WS_ID);
    expect(remember).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: PERSONAL_WS_ID }),
      expect.anything()
    );
  });

  it("scopeOwner: 'workspace:<target>' is still accepted alongside a valid targetWorkspaceId", async () => {
    const remember = vi.fn(async () => ({ id: "fact_4", kind: "fact", staged: false }));
    const deps = {
      apiKeys: await makeKeyLookup(),
      cognitive: { remember },
      metricsPgClient: makeFakeSql({ role: "admin" }),
    } as unknown as ServerDeps;
    const app = buildMountHarness(deps, [mountRemember]);

    const res = await app.request("/remember", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({
        statement: "scopeOwner matches target",
        targetWorkspaceId: TARGET_WS_ID,
        scopeOwner: `workspace:${TARGET_WS_ID}`,
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { workspaceId: string };
    expect(body.workspaceId).toBe(TARGET_WS_ID);
  });
});
