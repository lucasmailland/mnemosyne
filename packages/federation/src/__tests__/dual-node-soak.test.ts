// W3 federation soak: real two-node HTTP sync over native node:http servers.
//
// What this proves:
//   1. pullFromPeer() makes a REAL HTTP request (no mock fetch) to a running server
//   2. The response is parsed and fed to SyncEngine.processBatch()
//   3. Items from node A appear in node B's InMemorySyncStorage after a pull
//   4. Multiple items sync correctly (batch convergence)
//   5. Incremental pull (since=) returns only newer items
//   6. Peer-down chaos: pullFromPeer to an unreachable port throws gracefully
//   7. Peer HTTP-error: pullFromPeer to a server returning 500 throws gracefully
//
// Auth: the real /memory/federation/items endpoint requires full mTLS+JWT.
// For this soak test, node A exposes a minimal HTTP stub that skips auth —
// proving the pullFromPeer→SyncEngine chain works end-to-end over real TCP.
// The authenticated path is exercised by server/src/__tests__/_mountHarness.ts
// + the unit-level auth tests in federation/src/__tests__/federation-auth.test.ts.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { FederatedItem } from "../SyncEngine.js";
import { SyncEngine } from "../SyncEngine.js";
import { InMemorySyncStorage } from "../InMemorySyncStorage.js";
import { pullFromPeer } from "../PullClient.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const noop = { warn: () => {}, info: () => {}, debug: () => {} };

function makeNodeB(workspaceId = "ws-test") {
  const storage = new InMemorySyncStorage();
  const engine = new SyncEngine({ storage, logger: noop, workspaceId });
  return { storage, engine };
}

interface NodeAOpts {
  items: FederatedItem[];
  nextCursor?: string | null;
  /** If set, the server responds with this HTTP status and ignores `items`. */
  errorStatus?: number;
}

/** Start a minimal HTTP server that serves GET /memory/federation/items. */
function startNodeA(opts: NodeAOpts): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (opts.errorStatus) {
        res.writeHead(opts.errorStatus, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "simulated upstream failure" }));
        return;
      }

      // Parse `since` query param for incremental pull tests
      const url = new URL(req.url ?? "/", "http://localhost");
      const since = url.searchParams.get("since");

      const visible = since
        ? opts.items.filter((item) => {
            // Only return items whose version > the `since` cursor (simplified)
            const sinceVersion = Number(since) || 0;
            return item.version > sinceVersion;
          })
        : opts.items;

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          items: visible,
          nextCursor: opts.nextCursor ?? null,
        }),
      );
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((r, e) => server.close((err) => (err ? e(err) : r()))),
      });
    });

    server.on("error", reject);
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("W3 federation dual-node soak — real HTTP", () => {
  let nodeA: { url: string; close: () => Promise<void> } | undefined;

  afterEach(async () => {
    if (nodeA) {
      await nodeA.close();
      nodeA = undefined;
    }
  });

  // ── 1. Single item sync ───────────────────────────────────────────────────

  it("node B pulls one item from node A via real HTTP and stores it", async () => {
    const items: FederatedItem[] = [
      {
        remoteId: "fact-001",
        version: 1,
        peerDomain: "node-a.test",
        payload: { statement: "The sky is blue" },
      },
    ];

    nodeA = await startNodeA({ items });
    const { storage, engine } = makeNodeB();

    const { items: pulled, secure } = await pullFromPeer(nodeA.url, "mk_fed_test");
    expect(secure).toBe(false);
    expect(pulled).toHaveLength(1);

    await engine.processBatch(pulled);

    const live = storage.listLive();
    expect(live).toHaveLength(1);
    expect(live[0]!.payload).toEqual({ statement: "The sky is blue" });
    // Attribution is ALWAYS overridden to "federation_received" (§20 invariant)
    expect(live[0]!.attribution).toBe("federation_received");
  });

  // ── 2. Batch convergence (10 items) ──────────────────────────────────────

  it("node B converges with node A after pulling a 10-item batch", async () => {
    const items: FederatedItem[] = Array.from({ length: 10 }, (_, i) => ({
      remoteId: `fact-${i.toString().padStart(3, "0")}`,
      version: i + 1,
      peerDomain: "node-a.test",
      payload: { index: i, content: `memory item ${i}` },
    }));

    nodeA = await startNodeA({ items });
    const { storage, engine } = makeNodeB();

    const { items: pulled } = await pullFromPeer(nodeA.url, "mk_fed_test");
    const results = await engine.processBatch(pulled);

    expect(results).toHaveLength(10);
    expect(results.every((r) => r.outcome === "upserted")).toBe(true);

    const live = storage.listLive();
    expect(live).toHaveLength(10);

    const remoteIds = new Set(live.map((i) => i.remoteId));
    for (let idx = 0; idx < 10; idx++) {
      expect(remoteIds.has(`fact-${idx.toString().padStart(3, "0")}`)).toBe(true);
    }
  });

  // ── 3. Idempotent re-pull (same batch, same result) ───────────────────────

  it("pulling the same batch twice does not duplicate items (idempotent upsert)", async () => {
    const items: FederatedItem[] = [
      { remoteId: "fact-idem", version: 1, peerDomain: "node-a.test", payload: { v: 1 } },
    ];

    nodeA = await startNodeA({ items });
    const { storage, engine } = makeNodeB();

    const { items: first } = await pullFromPeer(nodeA.url, "mk_fed_test");
    await engine.processBatch(first, { conflictResolution: "theirs_wins" });

    const { items: second } = await pullFromPeer(nodeA.url, "mk_fed_test");
    const results = await engine.processBatch(second, { conflictResolution: "theirs_wins" });

    // KEY invariant: same version re-pull never duplicates the item.
    // The outcome is skipped_tie_lost (tie-break keeps local) or no_change — both correct.
    expect(results[0]!.outcome).toMatch(/^(skipped_tie_lost|no_change|upserted)$/);

    // Exactly one live item — no duplicates
    expect(storage.listLive()).toHaveLength(1);
  });

  // ── 4. Incremental pull via `since` ───────────────────────────────────────

  it("pulls only new items when `since` cursor is provided", async () => {
    const items: FederatedItem[] = [
      { remoteId: "fact-old", version: 1, peerDomain: "node-a.test", payload: { age: "old" } },
      { remoteId: "fact-new", version: 5, peerDomain: "node-a.test", payload: { age: "new" } },
    ];

    nodeA = await startNodeA({ items });
    const { storage, engine } = makeNodeB();

    // First full pull (no since)
    const { items: all } = await pullFromPeer(nodeA.url, "mk_fed_test");
    await engine.processBatch(all);
    expect(storage.listLive()).toHaveLength(2);

    // Incremental pull with since=3 — only version > 3 should come back
    const { items: incremental } = await pullFromPeer(nodeA.url, "mk_fed_test", { since: "3" });
    expect(incremental).toHaveLength(1);
    expect(incremental[0]!.remoteId).toBe("fact-new");
  });

  // ── 5. Version upgrade: node A ships v2, node B accepts it ───────────────

  it("node B accepts a version upgrade from node A (v1 → v2)", async () => {
    const v1: FederatedItem[] = [
      { remoteId: "fact-ver", version: 1, peerDomain: "node-a.test", payload: { draft: true } },
    ];
    const v2: FederatedItem[] = [
      { remoteId: "fact-ver", version: 2, peerDomain: "node-a.test", payload: { draft: false } },
    ];

    nodeA = await startNodeA({ items: v1 });
    const { storage, engine } = makeNodeB();

    const { items: pull1 } = await pullFromPeer(nodeA.url, "mk_fed_test");
    await engine.processBatch(pull1, { conflictResolution: "theirs_wins" });
    await nodeA.close();
    nodeA = undefined;

    nodeA = await startNodeA({ items: v2 });

    const { items: pull2 } = await pullFromPeer(nodeA.url, "mk_fed_test");
    // theirs_wins ensures the incoming v2 supersedes v1 without triggering manual review
    const results = await engine.processBatch(pull2, { conflictResolution: "theirs_wins" });

    expect(results[0]!.outcome).toBe("upserted");
    const live = storage.listLive().filter((i) => i.remoteId === "fact-ver");
    expect(live).toHaveLength(1);
    expect(live[0]!.payload).toEqual({ draft: false });
  });

  // ── 6. Tombstone propagation ──────────────────────────────────────────────

  it("tombstone from node A causes node B to archive the local item", async () => {
    const items: FederatedItem[] = [
      { remoteId: "fact-del", version: 1, peerDomain: "node-a.test", payload: { data: "x" } },
    ];

    nodeA = await startNodeA({ items });
    const { storage, engine } = makeNodeB();

    const { items: initial } = await pullFromPeer(nodeA.url, "mk_fed_test");
    await engine.processBatch(initial);
    expect(storage.listLive()).toHaveLength(1);
    await nodeA.close();

    const tombstoned: FederatedItem[] = [
      {
        remoteId: "fact-del",
        version: 2,
        peerDomain: "node-a.test",
        payload: { data: "x" },
        deletedAt: new Date().toISOString(), // determinism-ok: tombstone timestamp; LWW merge asserts ordering not value
      },
    ];
    nodeA = await startNodeA({ items: tombstoned });

    const { items: tombPull } = await pullFromPeer(nodeA.url, "mk_fed_test");
    const results = await engine.processBatch(tombPull);

    expect(results[0]!.outcome).toBe("tombstoned");
    // Item is archived (not in listLive)
    expect(storage.listLive()).toHaveLength(0);
    // Deletion log has an entry
    expect(storage.listDeletionLog()).toHaveLength(1);
    expect(storage.listDeletionLog()[0]!.remoteId).toBe("fact-del");
  });

  // ── 7. Chaos: peer down — graceful error ──────────────────────────────────

  it("pullFromPeer throws a network error when the peer is unreachable", async () => {
    // Start a server, grab its ephemeral port, then immediately shut it down.
    // Connecting to that port once it's closed reliably produces ECONNREFUSED.
    const tmp = await startNodeA({ items: [] });
    const deadUrl = tmp.url;
    await tmp.close();

    await expect(pullFromPeer(deadUrl, "mk_fed_test")).rejects.toThrow();
  });

  // ── 8. Chaos: peer returns HTTP 500 ──────────────────────────────────────

  it("pullFromPeer throws when the peer responds with 500", async () => {
    nodeA = await startNodeA({ items: [], errorStatus: 500 });

    await expect(pullFromPeer(nodeA.url, "mk_fed_test")).rejects.toThrow(
      /Federation pull failed: 500/,
    );
  });

  // ── 9. Chaos: SyncEngine continues on item-level errors ──────────────────

  it("processBatch records error outcomes without crashing on bad items", async () => {
    const items: FederatedItem[] = [
      // version 0 is invalid (version-inflation guard can reject, but it should not throw)
      { remoteId: "fact-bad", version: 0, peerDomain: "node-a.test", payload: {} },
      { remoteId: "fact-good", version: 1, peerDomain: "node-a.test", payload: { ok: true } },
    ];

    nodeA = await startNodeA({ items });
    const { storage, engine } = makeNodeB();

    const { items: pulled } = await pullFromPeer(nodeA.url, "mk_fed_test");
    const results = await engine.processBatch(pulled);

    // Both items are processed; the bad one might be rejected but must not crash
    expect(results).toHaveLength(2);

    // The good item must make it through regardless
    const goodResult = results.find((r) => r.remoteId === "fact-good");
    expect(goodResult?.outcome).toBe("upserted");
    await expect(storage.findByRemoteId("fact-good", "ws-test")).resolves.not.toBeNull();
  });
});
