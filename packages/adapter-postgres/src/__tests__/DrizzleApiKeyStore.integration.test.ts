/**
 * Integration test: DrizzleApiKeyStore (§6 scoped keys, migration 0055).
 *
 * Boots a real pgvector container, applies all migrations (incl. 0055), and
 * exercises the full ApiKeyStore roundtrip: insert → lookup → markUsed →
 * recentUsage → deprecate → revoke → escrow. Runs via `test:integration`
 * (excluded from the unit run; needs Docker).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import type { ApiKeyRecord, KeyScope } from "@mnemo-ai/types";
import { createDrizzleClient } from "../DrizzleStorageAdapter.js";
import { DrizzleApiKeyStore } from "../DrizzleApiKeyStore.js";
import { migrate } from "../migrate.js";

const PG_IMAGE = "pgvector/pgvector:pg17";
const WS = "11111111-1111-1111-1111-111111111111";

let container: StartedTestContainer;
let store: DrizzleApiKeyStore;
let pg: { end: () => Promise<void> };

beforeAll(async () => {
  container = await new GenericContainer(PG_IMAGE)
    .withEnvironment({ POSTGRES_USER: "mnemo_test", POSTGRES_PASSWORD: "mnemo_test", POSTGRES_DB: "mnemo_test" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
    .start();
  const url = `postgres://mnemo_test:mnemo_test@${container.getHost()}:${container.getMappedPort(5432)}/mnemo_test`;
  await migrate({ databaseUrl: url, log: () => {} });
  const { db, pgClient } = createDrizzleClient(url);
  store = new DrizzleApiKeyStore(db);
  pg = pgClient as unknown as { end: () => Promise<void> };
}, 120_000);

afterAll(async () => {
  await pg?.end?.();
  await container?.stop();
});

function record(overrides: Partial<ApiKeyRecord> = {}): ApiKeyRecord {
  return {
    keyId: "keyid-001",
    prefix: "mk_live_",
    hashedSecret: "$argon2id$fake",
    workspaceId: WS,
    scopes: ["memory:read"] as KeyScope[], // intentionally minimal — testing RBAC scope enforcement
    status: "active",
    expiresAt: null,
    ipAllowlist: ["10.0.0.0/8"],
    createdAt: new Date("2026-01-01T00:00:00Z"),
    deprecatedAt: null,
    mfaSecret: null,
    isTest: false,
    ...overrides,
  };
}

describe("DrizzleApiKeyStore — §6 scoped-key roundtrip", () => {
  it("insert → lookup returns the persisted record", async () => {
    await store.insert(record());
    const got = await store.lookup("mk_live_", "keyid-001");
    expect(got).not.toBeNull();
    expect(got?.workspaceId).toBe(WS);
    expect(got?.scopes).toEqual(["memory:read"]);
    expect(got?.ipAllowlist).toEqual(["10.0.0.0/8"]);
    expect(got?.status).toBe("active");
  });

  it("lookup is prefix-scoped (wrong prefix → null)", async () => {
    expect(await store.lookup("mk_test_", "keyid-001")).toBeNull();
  });

  it("markUsed records usage that recentUsage returns newest-first", async () => {
    await store.markUsed("keyid-001", "1.2.3.4");
    await store.markUsed("keyid-001", "5.6.7.8");
    const usage = await store.recentUsage("keyid-001", 10);
    expect(usage.length).toBeGreaterThanOrEqual(2);
    expect(usage[0]?.ipAddress).toBe("5.6.7.8"); // newest first
  });

  it("deprecate flips status + stamps deprecatedAt", async () => {
    const when = new Date("2026-06-01T00:00:00Z");
    await store.deprecate("keyid-001", when);
    const got = await store.lookup("mk_live_", "keyid-001");
    expect(got?.status).toBe("deprecated");
    expect(got?.deprecatedAt?.toISOString()).toBe(when.toISOString());
  });

  it("revoke flips status to revoked", async () => {
    await store.revoke("keyid-001", "manual");
    expect((await store.lookup("mk_live_", "keyid-001"))?.status).toBe("revoked");
  });

  it("escrow persists key metadata without throwing", async () => {
    await expect(
      store.escrow({
        keyId: "keyid-001", prefix: "mk_live_", workspaceId: WS,
        scopes: ["memory:read"] as KeyScope[], action: "revoke",
        reason: "test", escrowedAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
      }),
    ).resolves.toBeUndefined();
  });
});
