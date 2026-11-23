import { describe, it, expect, vi } from "vitest";
import { createRouterTransport, createClient, Code } from "@connectrpc/connect";
import bcrypt from "bcrypt";
import { MnemosyneService } from "../../gen/mnemosyne_pb.js";
import { createMnemosyneRoutes, createAuthInterceptor } from "../../grpc.js";
import type { ServerDeps } from "../../deps.js";

const WS = "00000000-0000-0000-0000-000000000001";
const TOKEN = "mns_live_abcdefghijklmnopqrstu";

/**
 * Minimal in-process CacheAdapter implementing only get + set + incrWithTtl.
 *
 * The returned object exposes `store` so the test can wipe the §13 lastEdit
 * cooldown key between iterations — otherwise editCooldown=300s would block
 * the 2nd call regardless of any per-day cap. Wiping lastEdit deterministically
 * lets the test exercise ONLY the RDD-7 strengthen/weaken per-day caps that
 * WP3 is wiring in.
 */
function makeCounterCache() {
  const store = new Map<string, number>();
  return {
    store,
    id: "test-cache",
    capabilities: {},
    async get<T>(key: string): Promise<T | null> {
      return store.has(key) ? (store.get(key) as unknown as T) : null;
    },
    async set<T>(key: string, value: T): Promise<void> {
      store.set(key, value as unknown as number);
    },
    async delete(): Promise<void> {},
    async deletePattern(): Promise<number> {
      return 0;
    },
    async incrWithTtl(key: string): Promise<number> {
      const next = (store.get(key) ?? 0) + 1;
      store.set(key, next);
      return next;
    },
    async healthCheck() {
      return { healthy: true } as never;
    },
    async close(): Promise<void> {},
  };
}

/** Wipe the §13 cooldown key so the next SelfEdit isn't rejected by the 300s cooldown. */
function clearCooldown(store: Map<string, number>): void {
  for (const k of [...store.keys()]) {
    if (k.startsWith("mnemo:selfedit:lastedit:")) store.delete(k);
  }
}

/**
 * storage stub: updateWorth resolves so applySelfEdit succeeds for strengthen/weaken.
 *
 * P123: `getFact` was added because the target must now EXIST before any
 * self-edit branch acts on it. Before that check, this stub omitted it and the
 * test still passed — it was strengthening a fact that was not there, which is
 * precisely the behaviour the fix removed.
 */
function makeStorageStub() {
  return {
    getFact: vi.fn().mockResolvedValue({
      id: "fact_1",
      workspaceId: WS,
      statement: "un hecho que existe",
      status: "active",
      validTo: undefined,
    }),
    getStrategy: vi.fn().mockResolvedValue(null),
    updateWorth: vi.fn().mockResolvedValue(undefined),
    appendOutbox: vi.fn().mockResolvedValue(undefined),
    appendAuditEntry: vi.fn().mockResolvedValue(undefined),
  };
}

async function authedDeps(overrides: Partial<ServerDeps>): Promise<ServerDeps> {
  const keyHash = await bcrypt.hash(TOKEN, 12);
  const apiKeys = {
    listActive: vi.fn().mockResolvedValue([]),
    touch: vi.fn(),
    findByLookupHash: vi
      .fn()
      .mockResolvedValue({ id: "agent-A", keyHash, workspaceId: WS, scopes: ["memory:self_edit"] }),
  };
  return { apiKeys, ...overrides } as unknown as ServerDeps;
}

function makeClient(deps: ServerDeps) {
  const transport = createRouterTransport((r) => createMnemosyneRoutes(r, deps), {
    router: { interceptors: [createAuthInterceptor(deps)] },
  });
  const client = createClient(MnemosyneService, transport);
  return { client, headers: { authorization: `Bearer ${TOKEN}` } };
}

describe("gRPC SelfEdit enforces RDD-7 per-day caps", () => {
  it("rejects the 4th strengthen of the day (maxStrengthensPerDay=3)", async () => {
    const cache = makeCounterCache();
    const deps = await authedDeps({ cache: cache as never, storage: makeStorageStub() as never });
    const { client, headers } = makeClient(deps);

    // 3 strengthens across DISTINCT facts → all allowed (per-day cap not yet hit,
    // per-fact cap never hit because each target differs).
    for (let i = 1; i <= 3; i++) {
      clearCooldown(cache.store);
      const res = await client.selfEdit(
        { action: "strengthen", targetId: `fact-${i}`, reason: "verified correct" },
        { headers }
      );
      expect(res.applied).toBe(true);
    }

    // 4th strengthen (a new distinct fact) → blocked by the per-DAY cap.
    clearCooldown(cache.store);
    await expect(
      client.selfEdit(
        { action: "strengthen", targetId: "fact-4", reason: "verified correct" },
        { headers }
      )
    ).rejects.toMatchObject({ code: Code.PermissionDenied });
  });

  it("rejects the 6th weaken of the day (maxWeakensPerDay=5)", async () => {
    const cache = makeCounterCache();
    const deps = await authedDeps({ cache: cache as never, storage: makeStorageStub() as never });
    const { client, headers } = makeClient(deps);

    for (let i = 1; i <= 5; i++) {
      clearCooldown(cache.store);
      const res = await client.selfEdit(
        { action: "weaken", targetId: `fact-${i}`, reason: "found counter-evidence" },
        { headers }
      );
      expect(res.applied).toBe(true);
    }

    clearCooldown(cache.store);
    await expect(
      client.selfEdit(
        { action: "weaken", targetId: "fact-6", reason: "found counter-evidence" },
        { headers }
      )
    ).rejects.toMatchObject({ code: Code.PermissionDenied });
  });

  it("rejects a 2nd strengthen of the SAME fact same day (per-fact 1/day cap)", async () => {
    const cache = makeCounterCache();
    const deps = await authedDeps({ cache: cache as never, storage: makeStorageStub() as never });
    const { client, headers } = makeClient(deps);

    clearCooldown(cache.store);
    const first = await client.selfEdit(
      { action: "strengthen", targetId: "fact-X", reason: "verified correct" },
      { headers }
    );
    expect(first.applied).toBe(true);

    clearCooldown(cache.store);
    await expect(
      client.selfEdit(
        { action: "strengthen", targetId: "fact-X", reason: "verified correct" },
        { headers }
      )
    ).rejects.toMatchObject({ code: Code.PermissionDenied });
  });
});

describe("p50 PR7: gRPC SelfEdit emits action:self_edit with the resolved gRPC-transport provenance", () => {
  it("appends a self_edit audit entry on a successful call", async () => {
    const cache = makeCounterCache();
    const storage = makeStorageStub();
    const deps = await authedDeps({ cache: cache as never, storage: storage as never });
    const { client, headers } = makeClient(deps);

    clearCooldown(cache.store);
    const res = await client.selfEdit(
      { action: "strengthen", targetId: "fact-grpc-1", reason: "verified correct" },
      { headers }
    );

    expect(res.applied).toBe(true);
    expect(storage.appendAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WS,
        actorType: "user",
        actorId: "key:agent-A",
        action: "self_edit",
        resourceKind: "self_edit",
        resourceId: "fact-grpc-1",
        isTerminal: false,
        detail: expect.objectContaining({
          action: "strengthen",
          targetKind: "fact",
          agentId: "agent-A",
        }),
      })
    );
  });
});
