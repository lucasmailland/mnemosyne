/**
 * Contract tests for `resolveTargetWorkspace` (P57 slice 1) — the single
 * extracted membership-check helper, ported verbatim from `remember.ts`'s
 * former inline block (`:240-277`). Fake `postgres.Sql` pattern follows
 * `recall-scope-personal.test.ts`'s `makeFakeSql`.
 */
import { describe, it, expect, vi } from "vitest";
import { resolveTargetWorkspace } from "../workspace-target.js";

const KEY_WS_ID = "00000000-0000-0000-0000-aa0000000001";
const TARGET_WS_ID = "00000000-0000-0000-0000-aa0000000002";
const USER_ID = "user-workspace-target-test-001";

/** Mirrors the single query the helper issues inside `sql.begin(...)`. */
function makeFakeSql(opts: { role?: string | null; throwOnQuery?: boolean }) {
  const setConfig = vi.fn(async () => []);
  const memberQuery = vi.fn(async () => {
    if (opts.throwOnQuery) throw new Error("simulated DB failure");
    return opts.role ? [{ role: opts.role }] : [];
  });
  const tx = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    if (text.includes("set_config")) return setConfig();
    if (text.includes("mnemo_workspace_member")) return memberQuery();
    return Promise.resolve([]);
  };
  const sql = {
    begin: vi.fn(async (fn: (tx: typeof tx) => Promise<unknown>) => fn(tx)),
  } as unknown as import("postgres").Sql;
  return { sql, setConfig, memberQuery };
}

describe("resolveTargetWorkspace", () => {
  it("targetWorkspaceId absent → resolves to keyWorkspaceId, zero DB calls", async () => {
    const { sql } = makeFakeSql({});
    const beginSpy = sql.begin as unknown as ReturnType<typeof vi.fn>;

    const result = await resolveTargetWorkspace({
      keyWorkspaceId: KEY_WS_ID,
      targetWorkspaceId: undefined,
      userId: USER_ID,
      sql,
    });

    expect(result).toEqual({ ok: true, workspaceId: KEY_WS_ID, crossWorkspace: false });
    expect(beginSpy).not.toHaveBeenCalled();
  });

  it("targetWorkspaceId === keyWorkspaceId → resolves without a DB call", async () => {
    const { sql } = makeFakeSql({});
    const beginSpy = sql.begin as unknown as ReturnType<typeof vi.fn>;

    const result = await resolveTargetWorkspace({
      keyWorkspaceId: KEY_WS_ID,
      targetWorkspaceId: KEY_WS_ID,
      userId: USER_ID,
      sql,
    });

    expect(result).toEqual({ ok: true, workspaceId: KEY_WS_ID, crossWorkspace: false });
    expect(beginSpy).not.toHaveBeenCalled();
  });

  it("no userId → 403 'requires a user-bound key'", async () => {
    const { sql } = makeFakeSql({});

    const result = await resolveTargetWorkspace({
      keyWorkspaceId: KEY_WS_ID,
      targetWorkspaceId: TARGET_WS_ID,
      userId: null,
      sql,
    });

    expect(result).toEqual({
      ok: false,
      status: 403,
      body: {
        error: "forbidden",
        message:
          "targetWorkspaceId requires a user-bound key (mk_user_* or mk_live_* with user_id)",
      },
    });
  });

  it("no sql → 403 'requires a user-bound key'", async () => {
    const result = await resolveTargetWorkspace({
      keyWorkspaceId: KEY_WS_ID,
      targetWorkspaceId: TARGET_WS_ID,
      userId: USER_ID,
      sql: undefined,
    });

    expect(result).toEqual({
      ok: false,
      status: 403,
      body: {
        error: "forbidden",
        message:
          "targetWorkspaceId requires a user-bound key (mk_user_* or mk_live_* with user_id)",
      },
    });
  });

  it("no mnemo_workspace_member row for target → 403 'not a write member'", async () => {
    const { sql } = makeFakeSql({ role: null });

    const result = await resolveTargetWorkspace({
      keyWorkspaceId: KEY_WS_ID,
      targetWorkspaceId: TARGET_WS_ID,
      userId: USER_ID,
      sql,
    });

    expect(result).toEqual({
      ok: false,
      status: 403,
      body: { error: "forbidden", message: "User is not a write member of the target workspace" },
    });
  });

  it("role 'read' → 403, identical message/shape to the no-row case", async () => {
    const { sql } = makeFakeSql({ role: "read" });

    const result = await resolveTargetWorkspace({
      keyWorkspaceId: KEY_WS_ID,
      targetWorkspaceId: TARGET_WS_ID,
      userId: USER_ID,
      sql,
    });

    expect(result).toEqual({
      ok: false,
      status: 403,
      body: { error: "forbidden", message: "User is not a write member of the target workspace" },
    });
  });

  it.each(["write", "admin", "owner"])(
    "role '%s' → resolves to the target workspace",
    async (role) => {
      const { sql } = makeFakeSql({ role });

      const result = await resolveTargetWorkspace({
        keyWorkspaceId: KEY_WS_ID,
        targetWorkspaceId: TARGET_WS_ID,
        userId: USER_ID,
        sql,
      });

      expect(result).toEqual({ ok: true, workspaceId: TARGET_WS_ID, crossWorkspace: true });
    }
  );

  it("query throws → 403, fail-closed, same message as the no-row case, no exception escapes", async () => {
    const { sql } = makeFakeSql({ throwOnQuery: true });

    const result = await resolveTargetWorkspace({
      keyWorkspaceId: KEY_WS_ID,
      targetWorkspaceId: TARGET_WS_ID,
      userId: USER_ID,
      sql,
    });

    expect(result).toEqual({
      ok: false,
      status: 403,
      body: { error: "forbidden", message: "User is not a write member of the target workspace" },
    });
  });

  it("sets the actor_user_id GUC before querying membership", async () => {
    const { sql, setConfig, memberQuery } = makeFakeSql({ role: "write" });

    await resolveTargetWorkspace({
      keyWorkspaceId: KEY_WS_ID,
      targetWorkspaceId: TARGET_WS_ID,
      userId: USER_ID,
      sql,
    });

    expect(setConfig).toHaveBeenCalledTimes(1);
    expect(memberQuery).toHaveBeenCalledTimes(1);
  });
});
