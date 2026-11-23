/**
 * Migration 0066 renames the origin of pulled items from a peer's host name to
 * its registered peer id, only where that is unambiguous.
 *
 * Applies every migration, then seeds peers and items the way a server before
 * the rename left them, and runs 0066 again (it is idempotent): only items
 * under a host that exactly one peer has, and that no peer uses as its id,
 * take that peer's id.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import postgres from "postgres";

import { migrate } from "../migrate.js";

const MIGRATION = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../migrations/baseline/0066_federated_item_peer_domain_backfill.sql"
);
const WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01";

let container: StartedTestContainer;
let sql: ReturnType<typeof postgres>;

beforeAll(async () => {
  container = await new GenericContainer("pgvector/pgvector:pg17")
    .withEnvironment({ POSTGRES_USER: "mnemo", POSTGRES_PASSWORD: "mnemo", POSTGRES_DB: "mnemo" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
    .start();
  const url = `postgres://mnemo:mnemo@${container.getHost()}:${container.getMappedPort(5432)}/mnemo`;
  await migrate({ databaseUrl: url, log: () => void 0 });
  sql = postgres(url, { max: 1, onnotice: () => void 0 });
}, 120_000);

afterAll(async () => {
  await sql?.end().catch(() => void 0);
  await container?.stop().catch(() => void 0);
});

describe("0066 federated item origin backfill", () => {
  it("renames only hosts that name exactly one registered peer", async () => {
    const peers: Array<[string, string]> = [
      ["acme.example", "https://Acme-Host.example:8443/memory"],
      ["one.example", "https://shared.example"],
      ["two.example", "https://shared.example/b"],
      // Its host is another peer's id: a row under it may already be that peer's.
      ["x.example", "https://y.example"],
      ["y.example", "https://z.example"],
    ];
    for (const [peerId, url] of peers) {
      await sql`
        INSERT INTO mnemosyne.mnemo_federation_peer (peer_id, pinned_cert_der, trust_weight, approved_at, url)
        VALUES (${peerId}, '\\x01'::bytea, 1, '2026-01-01T00:00:00Z', ${url})`;
    }
    const domains = ["acme-host.example", "shared.example", "y.example", "gone.example"];
    for (const [i, domain] of domains.entries()) {
      await sql`
        INSERT INTO mnemosyne.mnemo_federated_item (workspace_id, remote_id, peer_domain, version, payload)
        VALUES (${WS}::uuid, ${`r${i}`}, ${domain}, 1, '{}'::jsonb)`;
    }

    await sql.begin((tx) => tx.unsafe(readFileSync(MIGRATION, "utf8")));

    const rows = await sql<{ remote_id: string; peer_domain: string }[]>`
      SELECT remote_id, peer_domain FROM mnemosyne.mnemo_federated_item ORDER BY remote_id`;
    expect(rows).toEqual([
      { remote_id: "r0", peer_domain: "acme.example" },
      { remote_id: "r1", peer_domain: "shared.example" },
      { remote_id: "r2", peer_domain: "y.example" },
      { remote_id: "r3", peer_domain: "gone.example" },
    ]);
  });
});
