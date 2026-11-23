import { describe, it, expect, beforeEach, vi } from "vitest";
import { SyncEngine } from "../SyncEngine.js";
import { InMemorySyncStorage } from "../InMemorySyncStorage.js";
import type { FederatedItem, SyncStorage, ProcessItemOpts } from "../SyncEngine.js";

const logger = { warn() {}, info() {}, debug() {} };

function incoming(over: Partial<FederatedItem> = {}): FederatedItem {
  return {
    remoteId: "r1",
    version: 2,
    peerDomain: "peer.example.com",
    payload: { attribution: "user_stated", worth: 0.5, validFrom: "2026-06-10T00:00:00Z", statement: "v2" },
    ...over,
  };
}

async function seedLocal(storage: InMemorySyncStorage) {
  await storage.seedLocal({
    localId: "l1",
    remoteId: "r1",
    workspaceId: "ws1",
    version: 1,
    peerDomain: "old.example.com",
    attribution: "user_stated",
    worth: 0.5,
    validFrom: "2026-06-05T00:00:00Z",
  });
}

describe("SyncEngine — §20 merge (supersession chain) strategy", () => {
  let storage: InMemorySyncStorage;
  beforeEach(() => {
    storage = new InMemorySyncStorage();
  });

  it("merge supersedes the prior item, retains it, records the chain link, and upserts incoming", async () => {
    await seedLocal(storage);
    const engine = new SyncEngine({ storage, logger, workspaceId: "ws1" });

    const r = await engine.processItem(incoming(), { conflictResolution: "merge" });
    expect(r.outcome).toBe("merged_superseded");

    // Supersession recorded
    const chain = storage.listSupersession();
    expect(chain).toHaveLength(1);
    expect(chain[0]!.supersededLocalId).toBe("l1");
    expect(chain[0]!.remoteId).toBe("r1");

    // Prior item retained (archived), incoming is the new current item under a new localId
    const all = storage.listAll();
    const prior = all.find((i) => i.localId === "l1");
    expect(prior?.archived).toBe(true);

    const current = await storage.findByRemoteId("r1", "ws1");
    expect(current).not.toBeNull();
    expect(current!.localId).not.toBe("l1"); // fresh localId → prior not overwritten
    expect(current!.version).toBe(2);

    // Security invariant preserved on the merged upsert
    expect(await storage.attributionOf("r1", "ws1")).toBe("federation_received");

    // Live set has exactly one current item for r1
    expect(storage.listLive().filter((i) => i.remoteId === "r1")).toHaveLength(1);
  });

  it("merge degrades to theirs_wins upsert (no review, with warning) when storage lacks markSuperseded", async () => {
    // A storage adapter that predates merge support: implement SyncStorage WITHOUT markSuperseded.
    const upsert = vi.fn(async () => ({ localId: "new" }));
    const legacyStorage: SyncStorage = {
      findByRemoteId: async () => ({
        localId: "l1",
        remoteId: "r1",
        version: 1,
        workspaceId: "ws1",
        peerDomain: "old.example.com",
        attribution: "user_stated",
        worth: 0.5,
        validFrom: "2026-06-05T00:00:00Z",
      }),
      isInDeletionLog: async () => false,
      upsertFederatedItem: upsert,
      archiveLocalItem: async () => {},
      insertDeletionLog: async () => {},
      // markSuperseded intentionally absent
    };
    const warn = vi.fn();
    const engine = new SyncEngine({
      storage: legacyStorage,
      logger: { warn, info() {}, debug() {} },
      workspaceId: "ws1",
    });

    const r = await engine.processItem(incoming(), { conflictResolution: "merge" });
    // Falls through to a plain upsert (theirs_wins semantics) — NOT the resolver/contested path.
    expect(r.outcome).toBe("upserted");
    expect(upsert).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls.some((c) => /markSuperseded/.test(String(c[0])))).toBe(true);
  });

  it("merge on a brand-new item (no local) just upserts (nothing to supersede)", async () => {
    const engine = new SyncEngine({ storage, logger, workspaceId: "ws1" });
    const r = await engine.processItem(incoming({ remoteId: "brand-new" }), {
      conflictResolution: "merge",
    });
    expect(r.outcome).toBe("upserted");
    expect(storage.listSupersession()).toHaveLength(0);
  });
});

describe("SyncEngine — §20 processBatch threads the conflictResolution strategy", () => {
  let storage: InMemorySyncStorage;
  beforeEach(() => {
    storage = new InMemorySyncStorage();
  });

  it("processBatch passes opts.conflictResolution through to processItem", async () => {
    const engine = new SyncEngine({ storage, logger, workspaceId: "ws1" });
    const spy = vi.spyOn(engine, "processItem");
    const opts: ProcessItemOpts = { conflictResolution: "merge" };

    await engine.processBatch([incoming({ remoteId: "a" }), incoming({ remoteId: "b" })], opts);

    expect(spy).toHaveBeenCalledTimes(2);
    for (const call of spy.mock.calls) {
      expect(call[1]).toEqual(opts);
    }
  });

  it("ours_wins threaded through processBatch keeps every local item (no upsert)", async () => {
    await storage.seedLocal({
      localId: "l1", remoteId: "r1", workspaceId: "ws1", version: 1, peerDomain: "old.example.com",
      attribution: "objective_fact", worth: 0.9, validFrom: "2026-06-05T00:00:00Z",
    });
    const engine = new SyncEngine({ storage, logger, workspaceId: "ws1" });

    const results = await engine.processBatch([incoming()], { conflictResolution: "ours_wins" });
    expect(results[0]!.outcome).toBe("skipped_resolver_kept_local");
    // local untouched at version 1
    const current = await storage.findByRemoteId("r1", "ws1");
    expect(current!.version).toBe(1);
  });

  it("merge threaded through processBatch supersedes for each conflicting item", async () => {
    await storage.seedLocal({
      localId: "l1", remoteId: "r1", workspaceId: "ws1", version: 1, peerDomain: "old.example.com",
      attribution: "user_stated", worth: 0.5, validFrom: "2026-06-05T00:00:00Z",
    });
    const engine = new SyncEngine({ storage, logger, workspaceId: "ws1" });

    const results = await engine.processBatch([incoming()], { conflictResolution: "merge" });
    expect(results[0]!.outcome).toBe("merged_superseded");
    expect(storage.listSupersession()).toHaveLength(1);
  });

  it("backward-compat: processBatch with no opts still runs the default resolver path", async () => {
    await storage.seedLocal({
      localId: "l1", remoteId: "r1", workspaceId: "ws1", version: 1, peerDomain: "old.example.com",
      attribution: "objective_fact", worth: 0.9, validFrom: "2026-06-05T00:00:00Z",
    });
    const engine = new SyncEngine({ storage, logger, workspaceId: "ws1" });
    // incoming is low-trust/low-worth → default resolver keeps local
    const results = await engine.processBatch([
      incoming({ payload: { attribution: "inferred", worth: 0.1, validFrom: "2026-01-01T00:00:00Z" } }),
    ]);
    expect(results[0]!.outcome).toBe("skipped_resolver_kept_local");
  });
});

// ─── §20 HTTP/gRPC production path — conflictResolution threading ─────────────
// These tests mirror exactly how packages/server routes/federation.ts and grpc.ts
// now call processBatch after the Commit 3 fix:
//
//   HTTP: processBatch(pullItems, conflictResolution ? { conflictResolution } : undefined)
//   gRPC: processBatch(items,     batchConflictResolution ? { conflictResolution: batchConflictResolution } : undefined)
//
// Both paths use the same conditional-opt idiom, so the tests below prove that:
//   (a) passing the opt as a conditional object routes to processItem correctly;
//   (b) passing undefined (no CR in body/delta) falls back to the default resolver.

describe("SyncEngine — HTTP/gRPC production call-site pattern", () => {
  let storage: InMemorySyncStorage;
  beforeEach(() => {
    storage = new InMemorySyncStorage();
  });

  it("theirs_wins threaded via conditional-opts object upserts incoming when incoming is newer", async () => {
    // Seed local at version 1 so the incoming (version 2) is definitively newer.
    await storage.seedLocal({
      localId: "l1", remoteId: "r1", workspaceId: "ws1", version: 1, peerDomain: "old.example.com",
      attribution: "objective_fact", worth: 0.99, validFrom: "2030-01-01T00:00:00Z",
    });
    const engine = new SyncEngine({ storage, logger, workspaceId: "ws1" });
    const spy = vi.spyOn(engine, "processItem");

    // Simulates the HTTP handler: `conflictResolution ? { conflictResolution } : undefined`
    const conflictResolution: import("../SyncEngine.js").ConflictResolution = "theirs_wins";
    const results = await engine.processBatch([incoming()], { conflictResolution });

    expect(spy).toHaveBeenCalledTimes(1);
    // processItem receives the full opts object — this is the key assertion
    // proving the server's conditional-opts pattern threads through correctly.
    expect(spy.mock.calls[0]![1]).toEqual({ conflictResolution: "theirs_wins" });
    expect(results[0]!.outcome).toBe("upserted");
  });

  it("undefined opts (no CR in body/delta) leaves processItem receiving undefined", async () => {
    const engine = new SyncEngine({ storage, logger, workspaceId: "ws1" });
    const spy = vi.spyOn(engine, "processItem");

    // Simulates the HTTP/gRPC path when body has no conflictResolution field →
    // opts is undefined, not { conflictResolution: undefined }
    const opts: ProcessItemOpts | undefined = undefined;
    await engine.processBatch([incoming({ remoteId: "brand-new-2" })], opts);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![1]).toBeUndefined();
    expect(spy.mock.results[0]!.type).toBe("return"); // no throw
  });
});
