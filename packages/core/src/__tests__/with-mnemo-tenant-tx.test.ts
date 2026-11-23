import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withMnemoTenantTx } from "../tx.js";
import { setDb, __resetDbForTests } from "../db/index.js";

function makeFakeDb() {
  const executed: unknown[] = [];
  const fakeTx = {
    execute: vi.fn(async (q: unknown) => {
      executed.push(q);
      // Return a truthy pg_has_role result so SET ROLE / search_path execute.
      return [{ m: true }];
    }),
  };
  const fakeDb = {
    transaction: vi.fn(async (fn: (tx: typeof fakeTx) => Promise<unknown>) => fn(fakeTx)),
  };
  return { fakeDb, fakeTx, executed };
}

describe("withMnemoTenantTx", () => {
  beforeEach(() => {
    __resetDbForTests();
  });
  afterEach(() => {
    __resetDbForTests();
  });

  it("runs fn inside a transaction and returns its result", async () => {
    const { fakeDb } = makeFakeDb();
    setDb(fakeDb as never);

    const result = await withMnemoTenantTx({ workspaceId: "ws-1" }, async () => "ok");
    expect(result).toBe("ok");
    expect(fakeDb.transaction).toHaveBeenCalledOnce();
  });

  it("calls execute for SET ROLE, search_path, and workspace GUCs", async () => {
    const { fakeDb, fakeTx } = makeFakeDb();
    setDb(fakeDb as never);

    await withMnemoTenantTx({ workspaceId: "ws-2" }, async () => undefined);
    // SET LOCAL ROLE, SET LOCAL search_path, app.workspace_id, mnemosyne.workspace_id = 4 calls minimum
    expect(fakeTx.execute.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it("sets actor_user_id and actor_tenant_id GUCs when provided", async () => {
    const { fakeDb, fakeTx } = makeFakeDb();
    setDb(fakeDb as never);

    await withMnemoTenantTx(
      { workspaceId: "ws-3", userId: "u-abc", tenantId: "t-xyz" },
      async () => undefined,
    );
    // 4 base + 2 optional GUCs = 6 execute calls
    expect(fakeTx.execute.mock.calls.length).toBeGreaterThanOrEqual(6);
  });

  it("skips optional GUCs when userId and tenantId are null", async () => {
    const { fakeDb, fakeTx } = makeFakeDb();
    setDb(fakeDb as never);

    await withMnemoTenantTx(
      { workspaceId: "ws-4", userId: null, tenantId: null },
      async () => undefined,
    );
    // 5 base calls: pg_has_role + SET ROLE + search_path + 2 workspace GUCs (no optional ones)
    expect(fakeTx.execute.mock.calls.length).toBe(5);
  });

  it("propagates errors thrown by fn", async () => {
    const { fakeDb } = makeFakeDb();
    setDb(fakeDb as never);

    await expect(
      withMnemoTenantTx({ workspaceId: "ws-5" }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });
});
