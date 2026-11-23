import { describe, it, expect, beforeEach } from "vitest";
import { SyncEngine } from "../SyncEngine.js";
import { InMemorySyncStorage } from "../InMemorySyncStorage.js";
import type { FederatedItem } from "../SyncEngine.js";

const logger = { warn() {}, info() {}, debug() {} };

function engine(storage: InMemorySyncStorage) {
  return new SyncEngine({ storage, logger, workspaceId: "ws1" });
}
function incoming(over: Partial<FederatedItem> = {}): FederatedItem {
  return {
    remoteId: "r1",
    version: 1,
    peerDomain: "peer.example.com",
    payload: { attribution: "objective_fact", worth: 0.9, validFrom: "2026-06-05T00:00:00Z" },
    ...over,
  };
}

describe("SyncEngine apply path — §20/§33 4 rules", () => {
  let storage: InMemorySyncStorage;
  beforeEach(() => {
    storage = new InMemorySyncStorage();
  });

  it("SECURITY: a spoofed high-trust incoming claim (objective_fact/high worth) does NOT supersede local — attribution is always capped to federation_received before the resolver runs, so a peer can never win by self-declaring a higher trust anchor", async () => {
    await storage.seedLocal({
      localId: "l1",
      remoteId: "r1",
      workspaceId: "ws1",
      version: 1,
      peerDomain: "old.example.com",
      attribution: "inferred",
      worth: 0.2,
      validFrom: "2026-01-01T00:00:00Z",
    });
    // incoming() claims attribution: "objective_fact" (would score 100 if trusted) — it is
    // ignored; the incoming vote is scored at federation_received (20), which even
    // "inferred" local data (40) decisively beats.
    const r = await engine(storage).processItem(incoming());
    expect(r.outcome).toBe("skipped_resolver_kept_local");
  });

  it("default strategy keeps local (skips) when local wins with conf>0.7", async () => {
    await storage.seedLocal({
      localId: "l1",
      remoteId: "r1",
      workspaceId: "ws1",
      version: 1,
      peerDomain: "old.example.com",
      attribution: "objective_fact",
      worth: 0.9,
      validFrom: "2026-06-05T00:00:00Z",
    });
    const r = await engine(storage).processItem(
      incoming({
        payload: { attribution: "inferred", worth: 0.1, validFrom: "2026-01-01T00:00:00Z" },
      })
    );
    expect(r.outcome).toBe("skipped_resolver_kept_local");
  });

  it("ambiguous verdict enqueues review (manual fallback)", async () => {
    // Both sides must be genuinely tied at the federation_received floor to reach
    // "ambiguous" now — incoming can no longer claim a higher trust anchor
    // (e.g. "user_stated") to force a tie against real local data; that claim is
    // always capped, so it would decisively LOSE to local "user_stated" (90 vs 20)
    // instead of tying. A true tie is two federation-received copies with equal
    // worth and recency.
    await storage.seedLocal({
      localId: "l1",
      remoteId: "r1",
      workspaceId: "ws1",
      version: 1,
      peerDomain: "old.example.com",
      attribution: "federation_received",
      worth: 0.5,
      validFrom: "2026-06-05T00:00:00Z",
    });
    const r = await engine(storage).processItem(
      incoming({
        payload: { attribution: "objective_fact", worth: 0.5, validFrom: "2026-06-05T00:00:00Z" },
      })
    );
    expect(r.outcome).toBe("contested_enqueued_review");
  });

  it("explicit conflictResolution='ours_wins' short-circuits (always keep local)", async () => {
    await storage.seedLocal({
      localId: "l1",
      remoteId: "r1",
      workspaceId: "ws1",
      version: 1,
      peerDomain: "old.example.com",
      attribution: "inferred",
      worth: 0.1,
      validFrom: "2026-01-01T00:00:00Z",
    });
    const r = await engine(storage).processItem(incoming(), { conflictResolution: "ours_wins" });
    expect(r.outcome).toBe("skipped_resolver_kept_local");
  });

  it("attribution is still capped to federation_received on upsert (security invariant preserved)", async () => {
    await engine(storage).processItem(incoming({ remoteId: "new1" }));
    const stored = await storage.findByRemoteId("new1", "ws1");
    expect(stored).not.toBeNull();
    expect(await storage.attributionOf("new1", "ws1")).toBe("federation_received");
  });
});

describe("SyncEngine — updates from the peer an item came from", () => {
  const fromPeer = (version: number, statement: string): FederatedItem => ({
    remoteId: "r1",
    version,
    peerDomain: "acme.example",
    payload: { statement, validFrom: "2026-06-05T00:00:00Z" },
  });

  it("a newer version from the same peer applies under the default strategy", async () => {
    const storage = new InMemorySyncStorage();
    const contested: string[] = [];
    const run = new SyncEngine({ storage, logger, workspaceId: "ws1" }).forWorkspace("ws1", {
      onContested: (c) => contested.push(c.remoteId),
    });
    expect((await run.processItem(fromPeer(1, "v1"))).outcome).toBe("upserted");
    expect((await run.processItem(fromPeer(2, "v2"))).outcome).toBe("upserted");
    expect((await storage.findByRemoteId("r1", "ws1"))?.version).toBe(2);
    expect(contested).toEqual([]);
  });

  it("the same or an older version from the same peer is no change", async () => {
    const storage = new InMemorySyncStorage();
    const run = new SyncEngine({ storage, logger, workspaceId: "ws1" });
    await run.processItem(fromPeer(2, "v2"));
    expect((await run.processItem(fromPeer(2, "v2"))).outcome).toBe("skipped_no_change");
    expect((await run.processItem(fromPeer(1, "v1"))).outcome).toBe("skipped_no_change");
  });

  it("a contested item reaches the handler forWorkspace was given", async () => {
    const storage = new InMemorySyncStorage();
    await storage.seedLocal({
      localId: "l1",
      remoteId: "r1",
      workspaceId: "ws2",
      version: 1,
      peerDomain: "old.example.com",
      attribution: "federation_received",
      worth: 0.5,
      validFrom: "2026-06-05T00:00:00Z",
    });
    const contested: Array<{ remoteId: string; workspaceId: string }> = [];
    const r = await engine(storage)
      .forWorkspace("ws2", { onContested: (c) => contested.push(c) })
      .processItem(incoming({ payload: { worth: 0.5, validFrom: "2026-06-05T00:00:00Z" } }));
    expect(r.outcome).toBe("contested_enqueued_review");
    expect(contested).toEqual([{ remoteId: "r1", workspaceId: "ws2" }]);
  });
});

describe("SyncEngine — origin checks", () => {
  const item = (over: Partial<FederatedItem> = {}): FederatedItem => ({
    remoteId: "11111111-1111-4111-8111-111111111111",
    version: 1,
    peerDomain: "acme.example",
    payload: { statement: "s", validFrom: "2026-06-05T00:00:00Z" },
    ...over,
  });
  const run = (storage: InMemorySyncStorage) =>
    new SyncEngine({ storage, logger, workspaceId: "ws1" }).forWorkspace("ws1");

  it("a jump of more than 100 versions from the item's own peer applies", async () => {
    const storage = new InMemorySyncStorage();
    await run(storage).processItem(item());
    expect((await run(storage).processItem(item({ version: 150 }))).outcome).toBe("upserted");
  });

  it("a jump of more than 100 versions from another peer is still rejected", async () => {
    const storage = new InMemorySyncStorage();
    await run(storage).processItem(item());
    const r = await run(storage).processItem(item({ version: 150, peerDomain: "rogue.example" }));
    expect(r.outcome).toBe("rejected_version_inflation");
  });

  it("a tombstone from another peer neither archives nor blocks the item", async () => {
    const storage = new InMemorySyncStorage();
    await run(storage).processItem(item());
    const deletedAt = "2026-06-06T00:00:00Z";
    const r = await run(storage).processItem(item({ peerDomain: "rogue.example", deletedAt }));
    expect(r.outcome).toBe("rejected_foreign_tombstone");
    expect(await storage.findByRemoteId(item().remoteId, "ws1")).not.toBeNull();
    expect(await storage.isInDeletionLog(item().remoteId, "ws1")).toBe(false);
  });

  it("a tombstone for an item we do not hold logs nothing", async () => {
    const storage = new InMemorySyncStorage();
    const r = await run(storage).processItem(item({ deletedAt: "2026-06-06T00:00:00Z" }));
    expect(r.outcome).toBe("skipped_no_change");
    expect(await storage.isInDeletionLog(item().remoteId, "ws1")).toBe(false);
    expect((await run(storage).processItem(item())).outcome).toBe("upserted");
  });

  it("the origin's tombstone archives and blocks a later copy", async () => {
    const storage = new InMemorySyncStorage();
    await run(storage).processItem(item());
    const deletedAt = "2026-06-06T00:00:00Z";
    expect((await run(storage).processItem(item({ deletedAt }))).outcome).toBe("tombstoned");
    expect((await run(storage).processItem(item({ version: 2 }))).outcome).toBe(
      "rejected_resurrection_guard"
    );
  });

  it("a peer reusing an old host name can neither update nor tombstone a copy stored under it", async () => {
    // A copy an older server stored under a host name, which a new peer now uses as its id.
    const storage = new InMemorySyncStorage();
    await run(storage).processItem(item({ peerDomain: "acme-host.example" }));
    const newcomer = (over: Partial<FederatedItem>) =>
      run(storage).processItem(item({ peerDomain: "newcomer.example", ...over }));
    expect((await newcomer({ deletedAt: "2026-06-06T00:00:00Z" })).outcome).toBe(
      "rejected_foreign_tombstone"
    );
    expect((await newcomer({ version: 150 })).outcome).toBe("rejected_version_inflation");
    expect(
      (await newcomer({ version: 2, payload: { statement: "overwritten" } })).outcome
    ).not.toBe("upserted");
    const kept = await storage.findByRemoteId(item().remoteId, "ws1");
    expect(kept).toMatchObject({ peerDomain: "acme-host.example", version: 1 });
  });
});
