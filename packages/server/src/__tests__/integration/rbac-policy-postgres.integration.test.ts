/**
 * §19 cross-replica policy invalidation without Redis (migration 0067): two
 * replicas, each with its own pool as the application role (NOSUPERUSER
 * NOBYPASSRLS) over the same database. Replica B caches "no policy" for an
 * agent; replica A writes a deny policy, then deletes it. B's own poll of the
 * change log must apply each within about 3 s instead of the 60 s cache TTL.
 * A writes through the store, not the route, so nothing in this process drops
 * B's cache except B's poll.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { createDrizzleClient, DrizzleAccessPolicyStore } from "@mnemo-ai/adapter-postgres";
import type { AccessPolicyRecord } from "@mnemo-ai/types";
import { createRbacMiddleware, pollPolicyChanges } from "../../middleware/rbac-policy.js";
import type { RbacDeps } from "../../middleware/rbac-policy.js";
import { migrate } from "../../../../adapter-postgres/src/migrate.js";

const PG_DB = "mnemo_test";
const APP_USER = "rbac_poll_app";
const APP_PASS = "rbac_poll_app_pass";
const WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0067";
const AGENT = "agent-acme-writer";

let container: StartedTestContainer;
let superSql: ReturnType<typeof postgres>;
let poolA: ReturnType<typeof createDrizzleClient>;
let poolB: ReturnType<typeof createDrizzleClient>;

beforeAll(async () => {
  container = await new GenericContainer("pgvector/pgvector:pg17")
    .withEnvironment({
      POSTGRES_USER: "mnemo_super",
      POSTGRES_PASSWORD: "mnemo_super",
      POSTGRES_DB: PG_DB,
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
    .start();
  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const superUrl = `postgres://mnemo_super:mnemo_super@${host}:${port}/${PG_DB}`;
  await migrate({ databaseUrl: superUrl, log: () => void 0 });
  superSql = postgres(superUrl, { max: 1, onnotice: () => void 0 });
  await superSql.unsafe(`
    CREATE ROLE ${APP_USER} LOGIN PASSWORD '${APP_PASS}'
      NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
    GRANT mnemo_app_role TO ${APP_USER};
    GRANT CONNECT ON DATABASE ${PG_DB} TO ${APP_USER};
    GRANT USAGE ON SCHEMA mnemosyne TO ${APP_USER};
  `);
  const appUrl = `postgres://${APP_USER}:${APP_PASS}@${host}:${port}/${PG_DB}`;
  poolA = createDrizzleClient(appUrl);
  poolB = createDrizzleClient(appUrl);
}, 120_000);

afterAll(async () => {
  await poolA?.pgClient.end().catch(() => void 0);
  await poolB?.pgClient.end().catch(() => void 0);
  await superSql?.end().catch(() => void 0);
  await container?.stop().catch(() => void 0);
});

const denyWrites: AccessPolicyRecord = {
  agentId: AGENT,
  workspaceId: WS,
  readScopes: ["memory:read"],
  writeScopes: [],
  selfEdit: { enabled: false },
  taskScopes: { canCreate: false, canDelegate: false, canDelegateTo: [] },
  limits: {
    maxWritesPerMinute: 120,
    maxRecallsPerMinute: 600,
    maxSessionsConcurrent: 10,
    maxSelfEditsPerSession: 3,
  },
  requireApprovalFor: [],
  federationAccess: "none",
} as AccessPolicyRecord;

describe("rbac policy invalidation over the Postgres change log, no Redis", () => {
  it("a write and a delete on replica A reach replica B's cache within 3 s", async () => {
    const storeA = new DrizzleAccessPolicyStore(poolA.db);
    const storeB = new DrizzleAccessPolicyStore(poolB.db);
    const mwB = createRbacMiddleware({
      accessPolicies: storeB,
      approvals: {} as RbacDeps["approvals"],
    });
    const ctx = {
      req: { method: "POST", path: "/remember", header: () => undefined, query: () => undefined },
      get: (key: string) => (key === "workspaceId" ? WS : key === "actorId" ? AGENT : undefined),
      header: vi.fn(),
      json: vi.fn(),
    };
    const writeOnB = () => mwB(ctx as never, async () => {});
    const pollB = pollPolicyChanges((afterSeq) => storeB.changesSince(afterSeq));
    try {
      await pollB.tick(); // B is up and has read the log head
      await writeOnB(); // no policy yet: allowed, and cached for 60 s

      await storeA.putPolicy(denyWrites);
      let start = performance.now();
      await vi.waitFor(
        () => expect(writeOnB()).rejects.toThrow(/scope 'memory:write' not granted/),
        {
          timeout: 3_000,
          interval: 100,
        }
      );
      expect(performance.now() - start).toBeLessThan(3_000);

      expect(await storeA.deletePolicy(WS, AGENT)).toBe(true);
      start = performance.now();
      await vi.waitFor(() => expect(writeOnB()).resolves.toBeUndefined(), {
        timeout: 3_000,
        interval: 100,
      });
      expect(performance.now() - start).toBeLessThan(3_000);
    } finally {
      pollB.stop();
    }
  });
});
