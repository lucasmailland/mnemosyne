/**
 * TEST-2 (federation slice) — dual-node-soak.test.ts already proves real HTTP
 * (pullFromPeer -> SyncEngine.processBatch) end-to-end, but node B's storage
 * there is InMemorySyncStorage, which loses everything on restart and never
 * touches the RLS-scoped `mnemosyne.mnemo_federated_item` / `mnemo_sync_tombstone`
 * tables a real deployment actually persists to (see
 * adapter-postgres/src/DrizzleSyncStorage.ts's own header comment: "Replaces
 * InMemorySyncStorage which loses all sync state on server restart.").
 *
 * This file swaps node B's storage for the real DrizzleSyncStorage against a
 * real Postgres (testcontainers, actual baseline migrations applied via the
 * adapter-postgres migrate CLI) — otherwise identical two-node real-HTTP shape
 * to dual-node-soak.test.ts. Node A stays a minimal unauthenticated HTTP stub
 * (same deliberate scoping as dual-node-soak.test.ts: the authenticated
 * /memory/federation/items path is covered by
 * server/src/__tests__/_mountHarness.ts + federation-auth.test.ts — building a
 * full second server here would cross out of this package's boundary).
 *
 * This proves the item a peer pull round-trips through the real S7 invariant
 * (attribution pinned to "federation_received") into durable Postgres storage
 * that a later real recall would read — the concrete gap TEST-2 flagged
 * ("packages/federation/src/__tests__/…integration.test.ts — one real
 * cross-instance federated recall").
 *
 * Requires Docker. Also requires Node >=22 locally — testcontainers'
 * http-wait-strategy import chain hits undici's `webidl.util.markAsUncloneable`,
 * which doesn't exist on Node 20 (matches ci.yml's integration-test job pinning
 * node-version: 22 while every other job stays on 20). Run with:
 *   mise exec node@22 -- pnpm --filter @mnemo-ai/federation test:integration
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { migrate } from "@mnemo-ai/adapter-postgres/migrate";
import { createDrizzleClient, DrizzleSyncStorage } from "@mnemo-ai/adapter-postgres";
import type { FederatedItem } from "../SyncEngine.js";
import { SyncEngine } from "../SyncEngine.js";
import { pullFromPeer } from "../PullClient.js";

const noop = { warn: () => {}, info: () => {}, debug: () => {} };
const WS = "dddddddd-dddd-4ddd-dddd-dddddddddddd";

let container: StartedTestContainer;
let raw: ReturnType<typeof postgres>;
let nodeA: { url: string; close: () => Promise<void> } | undefined;

interface NodeAOpts {
  items: FederatedItem[];
}

/** Same minimal unauthenticated HTTP stub as dual-node-soak.test.ts. */
function startNodeA(opts: NodeAOpts): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = createServer((_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ items: opts.items, nextCursor: null }));
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

beforeAll(async () => {
  container = await new GenericContainer("pgvector/pgvector:pg17")
    .withEnvironment({
      POSTGRES_USER: "mnemo",
      POSTGRES_PASSWORD: "mnemo",
      POSTGRES_DB: "mnemo_test",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const databaseUrl = `postgres://mnemo:mnemo@${host}:${port}/mnemo_test`;

  const bootstrap = postgres(databaseUrl, { onnotice: () => void 0 });
  try {
    await bootstrap.unsafe("CREATE EXTENSION IF NOT EXISTS vector");
  } finally {
    await bootstrap.end().catch(() => void 0);
  }

  await migrate({ databaseUrl, log: () => void 0 });

  raw = postgres(databaseUrl, { onnotice: () => void 0, max: 4 });
}, 120_000);

afterAll(async () => {
  await raw?.end().catch(() => void 0);
  await container?.stop().catch(() => void 0);
}, 60_000);

afterEach(async () => {
  if (nodeA) {
    await nodeA.close();
    nodeA = undefined;
  }
  // Reset federation tables between tests — each test starts from a clean slate.
  await raw.unsafe("TRUNCATE mnemosyne.mnemo_federated_item, mnemosyne.mnemo_sync_tombstone");
});

function makeRealNodeB() {
  const { db } = createDrizzleClient(
    `postgres://mnemo:mnemo@${container.getHost()}:${container.getMappedPort(5432)}/mnemo_test`
  );
  const storage = new DrizzleSyncStorage(db);
  const engine = new SyncEngine({ storage: storage as never, logger: noop, workspaceId: WS });
  return { storage, engine };
}

describe("federation dual-node — real HTTP pull into real Postgres storage (TEST-2)", () => {
  it("node B pulls a real item from node A over HTTP and persists it in real Postgres", async () => {
    const items: FederatedItem[] = [
      {
        remoteId: "fact-real-001",
        version: 1,
        peerDomain: "node-a.test",
        payload: { statement: "The sky is blue" },
      },
    ];
    nodeA = await startNodeA({ items });
    const { storage, engine } = makeRealNodeB();

    const { items: pulled } = await pullFromPeer(nodeA.url, "mk_fed_test");
    expect(pulled).toHaveLength(1);

    const results = await engine.processBatch(pulled);
    expect(results[0]!.outcome).toBe("upserted");

    // Read back through the SAME real Postgres-backed storage a later recall
    // would use — proves the item actually survived to durable storage, not
    // just an in-memory list that would vanish on process restart.
    const found = await storage.findByRemoteId("fact-real-001", WS);
    expect(found).not.toBeNull();
    expect(found?.remoteId).toBe("fact-real-001");
    expect(found?.peerDomain).toBe("node-a.test");

    // S7 invariant: federated items are ALWAYS capped at attribution
    // "federation_received" regardless of what the peer claimed — verify
    // straight from the row, not just through the SyncEngine's own contract.
    const rows = await raw<Array<{ attribution: string }>>`
      SELECT attribution FROM mnemosyne.mnemo_federated_item
      WHERE remote_id = 'fact-real-001' AND workspace_id = ${WS}
    `;
    expect(rows[0]?.attribution).toBe("federation_received");
  });

  it("re-pulling the same item is idempotent in real Postgres (no duplicate row)", async () => {
    const items: FederatedItem[] = [
      { remoteId: "fact-real-idem", version: 1, peerDomain: "node-a.test", payload: { v: 1 } },
    ];
    nodeA = await startNodeA({ items });
    const { engine } = makeRealNodeB();

    const { items: first } = await pullFromPeer(nodeA.url, "mk_fed_test");
    await engine.processBatch(first, { conflictResolution: "theirs_wins" });

    const { items: second } = await pullFromPeer(nodeA.url, "mk_fed_test");
    await engine.processBatch(second, { conflictResolution: "theirs_wins" });

    const rows = await raw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM mnemosyne.mnemo_federated_item
      WHERE remote_id = 'fact-real-idem' AND workspace_id = ${WS}
    `;
    expect(rows[0]?.n).toBe(1);
  });
});
