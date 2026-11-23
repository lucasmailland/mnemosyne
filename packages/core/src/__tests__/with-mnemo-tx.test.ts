import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withMnemoTx } from "../tx.js";
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

describe("withMnemoTx", () => {
  beforeEach(() => {
    __resetDbForTests();
  });
  afterEach(() => {
    __resetDbForTests();
  });

  it("runs fn inside a transaction and returns its result (legacy string-arg form)", async () => {
    const { fakeDb } = makeFakeDb();
    setDb(fakeDb as never);

    const result = await withMnemoTx("ws-1", async () => "ok");
    expect(result).toBe("ok");
    expect(fakeDb.transaction).toHaveBeenCalledOnce();
  });

  it("calls execute for SET ROLE, search_path, and workspace GUCs with no optional options", async () => {
    const { fakeDb, fakeTx } = makeFakeDb();
    setDb(fakeDb as never);

    await withMnemoTx({ workspaceId: "ws-2" }, async () => undefined);
    // pg_has_role + SET ROLE + search_path + app.workspace_id + mnemosyne.workspace_id = 5
    expect(fakeTx.execute.mock.calls.length).toBe(5);
  });

  it("sets app.actor_id and app.enforce_actor_isolation GUCs when provided (pre-existing v1.6 mechanism)", async () => {
    const { fakeDb, fakeTx } = makeFakeDb();
    setDb(fakeDb as never);

    await withMnemoTx(
      { workspaceId: "ws-3", actorId: "key:abc", enforceActorIsolation: true },
      async () => undefined
    );
    // 5 base + actorId + enforceActorIsolation = 7
    expect(fakeTx.execute.mock.calls.length).toBe(7);
  });

  it("sets mnemosyne.actor_user_id and app.enforce_user_isolation GUCs when userId/enforceUserIsolation are provided (provenance-identity fix, migration 0023)", async () => {
    const { fakeDb, fakeTx } = makeFakeDb();
    setDb(fakeDb as never);

    await withMnemoTx(
      { workspaceId: "ws-4", userId: "user-abc", enforceUserIsolation: true },
      async () => undefined
    );
    // 5 base + userId + enforceUserIsolation = 7
    expect(fakeTx.execute.mock.calls.length).toBe(7);
  });

  it("the actor-isolation and user-isolation mechanisms are independent and both apply when both are set", async () => {
    const { fakeDb, fakeTx } = makeFakeDb();
    setDb(fakeDb as never);

    await withMnemoTx(
      {
        workspaceId: "ws-5",
        actorId: "key:abc",
        enforceActorIsolation: true,
        userId: "user-abc",
        enforceUserIsolation: true,
      },
      async () => undefined
    );
    // 5 base + actorId + enforceActorIsolation + userId + enforceUserIsolation = 9
    expect(fakeTx.execute.mock.calls.length).toBe(9);
  });

  it("skips the new user-isolation GUCs when userId/enforceUserIsolation are omitted — no behavior change for existing callers", async () => {
    const { fakeDb, fakeTx } = makeFakeDb();
    setDb(fakeDb as never);

    await withMnemoTx({ workspaceId: "ws-6", userId: null }, async () => undefined);
    // Same 5 base calls as the no-options case — null userId is a no-op, matching
    // the existing actorId null-handling semantics.
    expect(fakeTx.execute.mock.calls.length).toBe(5);
  });

  it("propagates errors thrown by fn", async () => {
    const { fakeDb } = makeFakeDb();
    setDb(fakeDb as never);

    await expect(
      withMnemoTx({ workspaceId: "ws-7" }, async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
  });
});
