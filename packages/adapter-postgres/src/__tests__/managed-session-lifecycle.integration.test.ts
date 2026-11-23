import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { canonicalJson, sha256Hex, type HarnessEvent } from "../../../types/src/index.js";
import { createDrizzleClient, DrizzleStorageAdapter } from "../DrizzleStorageAdapter.js";
import { migrate } from "../migrate.js";

const PG_IMAGE = "pgvector/pgvector:pg17";
const PG_USER = "mnemo_test";
const PG_PASSWORD = "mnemo_test";
const PG_DB = "mnemo_test";
const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WS_A = "55555555-5555-4555-8555-555555555555";
const WS_B = "66666666-6666-4666-8666-666666666666";

let container: StartedTestContainer;
let databaseUrl: string;
let raw: postgres.Sql;
let adapter: DrizzleStorageAdapter;
let secondAdapter: DrizzleStorageAdapter;
let sessionSequence = 0;

/** Milliseconds on the database's clock — the one that stamps collapse_next_attempt_at. */
async function dbNowMs(): Promise<number> {
  const [row] = await raw<Array<{ ms: string }>>`
    SELECT (extract(epoch FROM clock_timestamp()) * 1000)::text AS ms`;
  return Number(row!.ms);
}

beforeAll(async () => {
  container = await new GenericContainer(PG_IMAGE)
    .withEnvironment({
      POSTGRES_USER: PG_USER,
      POSTGRES_PASSWORD: PG_PASSWORD,
      POSTGRES_DB: PG_DB,
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
    .start();
  databaseUrl = `postgres://${PG_USER}:${PG_PASSWORD}@${container.getHost()}:${container.getMappedPort(5432)}/${PG_DB}`;
  await migrate({ databaseUrl, log: () => undefined });
  raw = postgres(databaseUrl, { max: 10, connection: { search_path: "mnemosyne,public" } });
  const client = createDrizzleClient(databaseUrl);
  adapter = new DrizzleStorageAdapter(client.db, client.pgClient);
  const secondClient = createDrizzleClient(databaseUrl);
  secondAdapter = new DrizzleStorageAdapter(secondClient.db, secondClient.pgClient);
  await raw`
    INSERT INTO mnemosyne.mnemo_tenant (id, name)
    VALUES (${TENANT}, 'Managed lifecycle tenant')
    ON CONFLICT (id) DO NOTHING
  `;
  await raw`
    INSERT INTO mnemosyne.mnemo_workspace (id, name, tenant_id)
    VALUES (${WS_A}, 'Lifecycle A', ${TENANT}), (${WS_B}, 'Lifecycle B', ${TENANT})
    ON CONFLICT (id) DO NOTHING
  `;
}, 120_000);

afterAll(async () => {
  await adapter?.close();
  await secondAdapter?.close();
  await raw?.end();
  await container?.stop();
});

beforeEach(async () => {
  await raw`TRUNCATE TABLE mnemosyne.mnemo_session CASCADE`;
  await raw`
    UPDATE mnemosyne.mnemo_harness_workspace_control
    SET ingestion_enabled = true
    WHERE workspace_id IN (${WS_A}, ${WS_B})
  `;
});

async function seedManagedSession(
  workspaceId = WS_A,
  values: {
    status?: "active" | "collapse_pending" | "collapsed" | "archived";
    closeKind?: "authoritative" | "provisional" | null;
    lastActivityAt?: Date;
    closeGraceDeadline?: Date | null;
    leaseOwner?: string | null;
    leaseExpiresAt?: Date | null;
    nextAttemptAt?: Date | null;
    attempts?: number;
    archiveReason?: string | null;
  } = {}
): Promise<string> {
  // Hoisted out of the SQL below: a `//` marker inside a template literal is
  // not a comment, it is text, and would land in the statement.
  const seededNow = new Date(); // determinism-ok: seeded wall clock for rows whose timestamp no assertion reads
  sessionSequence += 1;
  const id = `managed-lifecycle-${sessionSequence}`;
  await raw`
    INSERT INTO mnemosyne.mnemo_session (
      id, workspace_id, status, source_host, source_session_id,
      source_client_instance_id, source_generation, predecessor_session_id,
      last_activity_at, close_kind, close_requested_at, close_grace_deadline,
      sensitivity, origin_actor_id, origin_actor_type, origin_sensitivity_ceiling,
      collapse_lease_owner, collapse_lease_expires_at, collapse_attempts,
      collapse_next_attempt_at, archive_reason, archived_at
    ) VALUES (
      ${id}, ${workspaceId}, ${values.status ?? "active"}, 'opencode', ${`host-${id}`},
      'client-1', 0, NULL, ${values.lastActivityAt ?? seededNow}, ${values.closeKind ?? null},
      ${values.closeKind ? seededNow : null}, ${values.closeGraceDeadline ?? null},
      'internal', 'key:test', 'api_key', 'internal', ${values.leaseOwner ?? null},
      ${values.leaseExpiresAt ?? null}, ${values.attempts ?? 0},
      ${values.nextAttemptAt ?? null}, ${values.archiveReason ?? null},
      ${values.status === "archived" ? seededNow : null}
    )
  `;
  return id;
}

async function sessionRow(id: string) {
  const [row] = await raw<Array<Record<string, unknown>>>`
    SELECT * FROM mnemosyne.mnemo_session WHERE id = ${id}
  `;
  return row!;
}

function hashEvent<T extends Omit<HarnessEvent, "payloadHash">>(event: T): HarnessEvent {
  return { ...event, payloadHash: sha256Hex(canonicalJson(event)) } as HarnessEvent;
}

async function ingest(event: HarnessEvent) {
  return adapter.ingestHarnessEvent({
    workspaceId: WS_A,
    provenance: {
      actorId: "key:test",
      actorType: "api_key",
      userId: null,
      sensitivityCeiling: "internal",
    },
    event,
    receivedAt: new Date(), // determinism-ok: ingestion timestamp is the caller's wall clock; the assertion never depends on its value
  });
}

describe("managed session lifecycle", () => {
  it.each(["retry", "archive"] as const)(
    "rejects %s when the lease expires while waiting on the session lock",
    async (mutation) => {
      const id = await seedManagedSession(WS_A, {
        status: "collapse_pending",
        closeKind: "authoritative",
        closeGraceDeadline: new Date(0),
        leaseOwner: "blocked-worker",
        leaseExpiresAt: new Date(Date.now() + 60_000), // determinism-ok: lease deadline is relative to database time by design; the test asserts expiry, not a fixed instant
      });
      let result!: Promise<unknown>;
      await raw.begin(async (tx) => {
        await tx`SELECT id FROM mnemosyne.mnemo_session WHERE id = ${id} FOR UPDATE`;
        result =
          mutation === "retry"
            ? adapter.markManagedCollapseRetry({
                workspaceId: WS_A,
                sessionId: id,
                leaseOwner: "blocked-worker",
                error: "transient",
                baseRetryMs: 1_000,
                maxRetryMs: 30_000,
              })
            : adapter.finalizeManagedArchive({
                workspaceId: WS_A,
                sessionId: id,
                leaseOwner: "blocked-worker",
                operationId: `expired:${id}`,
                reason: "no_pin",
              });
        await expect
          .poll(async () => {
            const [row] = await raw`SELECT count(*)::int AS count FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND query LIKE '%mnemo_session%'
            AND pid <> pg_backend_pid()`;
            return row!.count;
          })
          .toBeGreaterThan(0);
        await tx`UPDATE mnemosyne.mnemo_session SET collapse_lease_expires_at = clock_timestamp()
        WHERE id = ${id}`;
      });
      expect(await result).toBe(mutation === "retry" ? null : false);
      const session = await sessionRow(id);
      expect(session.status).toBe("collapse_pending");
      expect(session.collapse_attempts).toBe(0);
      expect(session.collapse_next_attempt_at).toBeNull();
      expect(session.archive_reason).toBeNull();
      expect(
        await raw`SELECT operation_id FROM mnemosyne.mnemo_managed_collapse_operation
      WHERE session_id = ${id}`
      ).toHaveLength(0);
    }
  );

  it("does not recreate archived work or reset its operation after quiesce", async () => {
    const id = await seedManagedSession(WS_A, {
      status: "collapse_pending",
      closeKind: "authoritative",
      closeGraceDeadline: new Date(0),
      leaseOwner: "worker",
      leaseExpiresAt: new Date(Date.now() + 60_000), // determinism-ok: lease deadline is relative to database time by design; the test asserts expiry, not a fixed instant
    });
    const operationId = `quiesced:${id}`;
    expect(
      await adapter.finalizeManagedArchive({
        workspaceId: WS_A,
        sessionId: id,
        leaseOwner: "worker",
        operationId,
        reason: "no_pin",
      })
    ).toBe(true);
    await raw`UPDATE mnemosyne.mnemo_harness_workspace_control
      SET ingestion_enabled = false WHERE workspace_id = ${WS_A}`;
    expect(await adapter.quiesceManagedLifecycle({ workspaceId: WS_A })).toEqual({
      pendingCount: 0,
      liveLeaseCount: 0,
      reactivatedCount: 0,
    });
    expect(await adapter.retryLegacyManagedArchive({ workspaceId: WS_A, sessionId: id })).toBe(
      false
    );
    expect((await sessionRow(id)).status).toBe("archived");
    const [operation] =
      await raw`SELECT status, committed_at FROM mnemosyne.mnemo_managed_collapse_operation
      WHERE operation_id = ${operationId}`;
    expect(operation!.status).toBe("committed");
    expect(operation!.committed_at).toBeInstanceOf(Date);
  });

  it("retry waits behind the workspace fence and observes a concurrent disable", async () => {
    const id = await seedManagedSession(WS_A, { status: "archived", archiveReason: "no_pin" });
    let retry!: Promise<boolean>;
    await raw.begin(async (tx) => {
      await tx`UPDATE mnemosyne.mnemo_harness_workspace_control
        SET ingestion_enabled = false WHERE workspace_id = ${WS_A}`;
      retry = adapter.retryLegacyManagedArchive({ workspaceId: WS_A, sessionId: id });
      await expect
        .poll(
          async () => {
            const [row] = await raw`SELECT count(*)::int AS count FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND query LIKE '%mnemo_harness_workspace_control%'
            AND pid <> pg_backend_pid()`;
            return row!.count;
          },
          { timeout: 2_000 }
        )
        .toBeGreaterThan(0);
    });
    expect(await retry).toBe(false);
    expect((await sessionRow(id)).status).toBe("archived");
  });

  it("claims use time after the workspace fence wait for due checks and lease duration", async () => {
    const id = await seedManagedSession(WS_A, {
      status: "collapse_pending",
      closeKind: "authoritative",
      closeGraceDeadline: new Date(0),
    });
    let claim!: ReturnType<typeof adapter.claimManagedSessions>;
    let releasedAt!: Date;
    await raw.begin(async (tx) => {
      await tx`SELECT workspace_id FROM mnemosyne.mnemo_harness_workspace_control
        WHERE workspace_id = ${WS_A} FOR UPDATE`;
      claim = adapter.claimManagedSessions({
        workspaceId: WS_A,
        leaseOwner: "waited-worker",
        limit: 1,
        inactivityMs: 60_000,
        provisionalGraceMs: 0,
        leaseMs: 30_000,
      });
      await expect
        .poll(async () => {
          const [row] = await raw`SELECT count(*)::int AS count FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND query LIKE '%mnemo_harness_workspace_control%'
            AND pid <> pg_backend_pid()`;
          return row!.count;
        })
        .toBeGreaterThan(0);
      await tx`UPDATE mnemosyne.mnemo_session SET close_grace_deadline = clock_timestamp(),
        collapse_next_attempt_at = clock_timestamp() WHERE id = ${id}`;
      const [row] = await tx`SELECT clock_timestamp() AS now`;
      releasedAt = row!.now;
    });
    const claims = await claim;
    expect(claims.map((entry) => entry.session.id)).toEqual([id]);
    expect(claims[0]!.leaseExpiresAt.getTime()).toBeGreaterThanOrEqual(
      releasedAt.getTime() + 30_000
    );
  });

  it("quiesce uses time after the workspace fence wait when a lease expires", async () => {
    const id = await seedManagedSession(WS_A, {
      status: "collapse_pending",
      closeKind: "authoritative",
      closeGraceDeadline: new Date(0),
      leaseOwner: "worker",
      leaseExpiresAt: new Date(Date.now() + 60_000), // determinism-ok: lease deadline is relative to database time by design; the test asserts expiry, not a fixed instant
    });
    let quiesce!: ReturnType<typeof adapter.quiesceManagedLifecycle>;
    await raw.begin(async (tx) => {
      await tx`UPDATE mnemosyne.mnemo_harness_workspace_control
        SET ingestion_enabled = false WHERE workspace_id = ${WS_A}`;
      quiesce = adapter.quiesceManagedLifecycle({ workspaceId: WS_A });
      await expect
        .poll(async () => {
          const [row] = await raw`SELECT count(*)::int AS count FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND query LIKE '%mnemo_harness_workspace_control%'
            AND pid <> pg_backend_pid()`;
          return row!.count;
        })
        .toBeGreaterThan(0);
      await tx`UPDATE mnemosyne.mnemo_session SET collapse_lease_expires_at = clock_timestamp()
        WHERE id = ${id}`;
    });
    expect(await quiesce).toEqual({ pendingCount: 0, liveLeaseCount: 0, reactivatedCount: 1 });
    expect((await sessionRow(id)).status).toBe("active");
  });

  it("preserves old-server status transitions without requiring new archive metadata", async () => {
    const id = await seedManagedSession();
    await raw`UPDATE mnemosyne.mnemo_session SET status = 'archived' WHERE id = ${id}`;
    expect((await sessionRow(id)).status).toBe("archived");
    await raw`UPDATE mnemosyne.mnemo_session SET status = 'collapsed', collapsed_at = now() WHERE id = ${id}`;
    expect((await sessionRow(id)).status).toBe("collapsed");
  });

  it("keeps authoritative close grace and claims only after its deadline", async () => {
    const future = new Date(Date.now() + 60_000); // determinism-ok: wall-clock value the assertion does not depend on
    const id = await seedManagedSession(WS_A, {
      status: "collapse_pending",
      closeKind: "authoritative",
      closeGraceDeadline: future,
    });

    expect(
      await adapter.claimManagedSessions({
        workspaceId: WS_A,
        leaseOwner: "worker-a",
        limit: 10,
        inactivityMs: 60_000,
        provisionalGraceMs: 5_000,
        leaseMs: 30_000,
      })
    ).toEqual([]);

    await raw`UPDATE mnemosyne.mnemo_session SET close_grace_deadline = NOW() - interval '1 second' WHERE id = ${id}`;
    const claims = await adapter.claimManagedSessions({
      workspaceId: WS_A,
      leaseOwner: "worker-a",
      limit: 10,
      inactivityMs: 60_000,
      provisionalGraceMs: 5_000,
      leaseMs: 30_000,
    });
    expect(claims.map((claim) => claim.session.id)).toContain(id);
    expect(claims.find((claim) => claim.session.id === id)?.session.closeKind).toBe(
      "authoritative"
    );
  });

  it("creates an unleased provisional close with grace before a later claim", async () => {
    const id = await seedManagedSession(WS_A, {
      lastActivityAt: new Date(Date.now() - 120_000), // determinism-ok: wall-clock value the assertion does not depend on
    });

    const first = await adapter.claimManagedSessions({
      workspaceId: WS_A,
      leaseOwner: "worker-a",
      limit: 10,
      inactivityMs: 60_000,
      provisionalGraceMs: 30_000,
      leaseMs: 30_000,
    });
    expect(first.map((claim) => claim.session.id)).not.toContain(id);
    const pending = await sessionRow(id);
    expect(pending.status).toBe("collapse_pending");
    expect(pending.close_kind).toBe("provisional");
    expect(pending.collapse_lease_owner).toBeNull();
    expect((pending.close_grace_deadline as Date).getTime()).toBeGreaterThan(
      (pending.close_requested_at as Date).getTime()
    );

    await raw`UPDATE mnemosyne.mnemo_session SET close_grace_deadline = NOW() - interval '1 second' WHERE id = ${id}`;
    const second = await adapter.claimManagedSessions({
      workspaceId: WS_A,
      leaseOwner: "worker-a",
      limit: 10,
      inactivityMs: 60_000,
      provisionalGraceMs: 30_000,
      leaseMs: 30_000,
    });
    expect(second.map((claim) => claim.session.id)).toContain(id);
  });

  it("bounds inactive-to-pending transitions by the claim limit", async () => {
    await Promise.all(
      Array.from(
        { length: 3 },
        () => seedManagedSession(WS_A, { lastActivityAt: new Date(Date.now() - 120_000) }) // determinism-ok: wall-clock value the assertion does not depend on
      )
    );

    await adapter.claimManagedSessions({
      workspaceId: WS_A,
      leaseOwner: "bounded-worker",
      limit: 1,
      inactivityMs: 60_000,
      provisionalGraceMs: 30_000,
      leaseMs: 30_000,
    });

    const [{ pending_count: pendingCount }] = await raw<Array<{ pending_count: number }>>`
      SELECT COUNT(*)::int AS pending_count
      FROM mnemosyne.mnemo_session
      WHERE workspace_id = ${WS_A} AND status = 'collapse_pending'
    `;
    expect(pendingCount).toBe(1);
  });

  it("uses SKIP LOCKED so another due session is claimed while one row is busy", async () => {
    const lockedId = await seedManagedSession(WS_A, {
      status: "collapse_pending",
      closeKind: "provisional",
      closeGraceDeadline: new Date(0),
    });
    const freeId = await seedManagedSession(WS_A, {
      status: "collapse_pending",
      closeKind: "provisional",
      closeGraceDeadline: new Date(0),
    });
    const blocker = postgres(databaseUrl, { max: 1 });
    let release!: () => void;
    const held = new Promise<void>((resolve, reject) => {
      void blocker
        .begin(async (tx) => {
          await tx`SELECT id FROM mnemosyne.mnemo_session WHERE id = ${lockedId} FOR UPDATE`;
          resolve();
          await new Promise<void>((done) => {
            release = done;
          });
        })
        .catch(reject);
    });
    await held;
    try {
      const claims = await adapter.claimManagedSessions({
        workspaceId: WS_A,
        leaseOwner: "worker-skip",
        limit: 1,
        inactivityMs: 60_000,
        provisionalGraceMs: 5_000,
        leaseMs: 30_000,
      });
      expect(claims.map((claim) => claim.session.id)).toEqual([freeId]);
    } finally {
      release();
      await blocker.end();
    }
  });

  it("serializes claims behind the workspace fence and rejects the losing post-quiesce claim", async () => {
    const id = await seedManagedSession(WS_A, {
      status: "collapse_pending",
      closeKind: "authoritative",
      closeGraceDeadline: new Date(0),
    });
    const blocker = postgres(databaseUrl, { max: 1 });
    let release!: () => void;
    const locked = new Promise<void>((resolve, reject) => {
      void blocker
        .begin(async (tx) => {
          await tx`
            SELECT workspace_id FROM mnemosyne.mnemo_harness_workspace_control
            WHERE workspace_id = ${WS_A} FOR UPDATE
          `;
          await tx`
            UPDATE mnemosyne.mnemo_harness_workspace_control
            SET ingestion_enabled = false, fence_epoch = fence_epoch + 1
            WHERE workspace_id = ${WS_A}
          `;
          resolve();
          await new Promise<void>((done) => {
            release = done;
          });
        })
        .catch(reject);
    });
    await locked;
    const claim = adapter.claimManagedSessions({
      workspaceId: WS_A,
      leaseOwner: "losing-worker",
      limit: 1,
      inactivityMs: 60_000,
      provisionalGraceMs: 1_000,
      leaseMs: 30_000,
    });
    const quiesce = adapter.quiesceManagedLifecycle({ workspaceId: WS_A });
    release();

    await expect(claim).resolves.toEqual([]);
    await expect(quiesce).resolves.toEqual({
      pendingCount: 0,
      liveLeaseCount: 0,
      reactivatedCount: 1,
    });
    expect((await sessionRow(id)).collapse_lease_owner).toBeNull();
    await blocker.end();
  });

  it("requires the workspace and lease owner for retry and archive finalization", async () => {
    const id = await seedManagedSession(WS_A, {
      status: "collapse_pending",
      closeKind: "authoritative",
      closeGraceDeadline: new Date(0),
      leaseOwner: "owner",
      leaseExpiresAt: new Date(Date.now() + 60_000), // determinism-ok: lease deadline is relative to database time by design; the test asserts expiry, not a fixed instant
    });

    expect(
      await adapter.markManagedCollapseRetry({
        workspaceId: WS_B,
        sessionId: id,
        leaseOwner: "owner",
        error: "temporary",
        baseRetryMs: 100,
        maxRetryMs: 1_000,
      })
    ).toBeNull();
    expect(
      await adapter.finalizeManagedArchive({
        workspaceId: WS_A,
        sessionId: id,
        leaseOwner: "not-owner",
        operationId: `archive:${id}`,
        reason: "empty_session",
      })
    ).toBe(false);
    expect((await sessionRow(id)).status).toBe("collapse_pending");
  });

  it("rejects retry and archive finalization after the worker lease expires", async () => {
    const id = await seedManagedSession(WS_A, {
      status: "collapse_pending",
      closeKind: "authoritative",
      closeGraceDeadline: new Date(0),
      leaseOwner: "stale-owner",
      leaseExpiresAt: new Date(Date.now() - 1_000), // determinism-ok: lease deadline is relative to database time by design; the test asserts expiry, not a fixed instant
    });

    expect(
      await adapter.markManagedCollapseRetry({
        workspaceId: WS_A,
        sessionId: id,
        leaseOwner: "stale-owner",
        error: "too late",
        baseRetryMs: 100,
        maxRetryMs: 1_000,
      })
    ).toBeNull();
    expect(
      await adapter.finalizeManagedArchive({
        workspaceId: WS_A,
        sessionId: id,
        leaseOwner: "stale-owner",
        operationId: `archive:${id}`,
        reason: "empty_session",
      })
    ).toBe(false);
    expect((await sessionRow(id)).status).toBe("collapse_pending");
  });

  it("recovers expired leases and schedules bounded retries without terminalizing", async () => {
    const expired = await seedManagedSession(WS_A, {
      status: "collapse_pending",
      closeKind: "provisional",
      closeGraceDeadline: new Date(0),
      leaseOwner: "dead-worker",
      leaseExpiresAt: new Date(Date.now() - 1_000), // determinism-ok: lease deadline is relative to database time by design; the test asserts expiry, not a fixed instant
    });
    expect(await adapter.releaseExpiredManagedLeases({ workspaceId: WS_A })).toBeGreaterThanOrEqual(
      1
    );
    expect((await sessionRow(expired)).collapse_lease_owner).toBeNull();
    await raw`
      INSERT INTO mnemosyne.mnemo_session_turn
        (workspace_id, session_id, turn_index, role, content, pinned)
      VALUES (${WS_A}::uuid, ${expired}, 0, 'user', 'leased collapse input', false)
    `;

    await raw`
      UPDATE mnemosyne.mnemo_session
      SET collapse_lease_owner = 'owner', collapse_lease_expires_at = NOW() + interval '1 minute',
          collapse_attempts = 20
      WHERE id = ${expired}
    `;
    const before = await dbNowMs();
    const retry = await adapter.markManagedCollapseRetry({
      workspaceId: WS_A,
      sessionId: expired,
      leaseOwner: "owner",
      error: "provider unavailable",
      baseRetryMs: 100,
      maxRetryMs: 1_000,
    });
    expect(retry?.attempts).toBe(21);
    expect(retry?.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before + 900);
    expect(retry?.nextAttemptAt.getTime()).toBeLessThanOrEqual((await dbNowMs()) + 1_200);
    expect((await sessionRow(expired)).status).toBe("collapse_pending");
    await expect(
      adapter.pinSessionTurn({
        workspaceId: WS_A,
        sessionId: expired,
        turnIndex: 0,
        pinned: true,
      })
    ).rejects.toMatchObject({ code: "SESSION_CLOSED" });
  });

  it("saturates collapse attempts at int max while retaining capped backoff", async () => {
    const id = await seedManagedSession(WS_A, {
      status: "collapse_pending",
      closeKind: "authoritative",
      closeGraceDeadline: new Date(0),
      leaseOwner: "max-worker",
      leaseExpiresAt: new Date(Date.now() + 60_000), // determinism-ok: lease deadline is relative to database time by design; the test asserts expiry, not a fixed instant
      attempts: 2_147_483_647,
    });
    const before = await dbNowMs();

    const retry = await adapter.markManagedCollapseRetry({
      workspaceId: WS_A,
      sessionId: id,
      leaseOwner: "max-worker",
      error: "still transient",
      baseRetryMs: 100,
      maxRetryMs: 1_000,
    });

    expect(retry?.attempts).toBe(2_147_483_647);
    expect(retry?.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before + 900);
    expect(retry?.nextAttemptAt.getTime()).toBeLessThanOrEqual((await dbNowMs()) + 1_200);
  });

  it("reopens provisional pending sessions before lease and creates one successor after lease", async () => {
    const source = `lifecycle-source-${++sessionSequence}`;
    const common = {
      host: "opencode" as const,
      clientInstanceId: "lifecycle-client",
      occurredAt: new Date().toISOString(), // determinism-ok: ingestion timestamp is the caller's wall clock; the assertion never depends on its value
      normalizationVersion: 1 as const,
    };
    const start = await ingest(
      hashEvent({
        ...common,
        eventId: `${source}-start`,
        hostSessionId: source,
        enqueueSequence: 1,
        type: "session.start",
      })
    );
    const provisional = start.sessionId!;
    await raw`
      UPDATE mnemosyne.mnemo_session
      SET status = 'collapse_pending', close_kind = 'provisional',
          close_requested_at = NOW(), close_grace_deadline = NOW() + interval '1 minute'
      WHERE id = ${provisional}
    `;
    await ingest(
      hashEvent({
        ...common,
        eventId: `${source}-resume`,
        hostSessionId: source,
        enqueueSequence: 2,
        type: "turn.append",
        sourceGeneration: 0,
        hostMessageId: "resume-before",
        role: "user",
        content: "resumed before lease",
        contentHash: sha256Hex("resumed before lease"),
      })
    );
    expect((await sessionRow(provisional)).status).toBe("active");

    const leasedSource = `${source}-leased`;
    const leasedStart = await ingest(
      hashEvent({
        ...common,
        eventId: `${leasedSource}-start`,
        hostSessionId: leasedSource,
        enqueueSequence: 1,
        type: "session.start",
      })
    );
    const leased = leasedStart.sessionId!;
    await raw`
      UPDATE mnemosyne.mnemo_session
      SET status = 'collapse_pending', close_kind = 'provisional',
          close_requested_at = NOW(), close_grace_deadline = NOW() - interval '1 second',
          collapse_lease_owner = 'worker', collapse_lease_expires_at = NOW() + interval '1 minute'
      WHERE id = ${leased}
    `;
    await Promise.all([
      ingest(
        hashEvent({
          ...common,
          eventId: `${leasedSource}-append-1`,
          hostSessionId: leasedSource,
          enqueueSequence: 2,
          type: "turn.append",
          sourceGeneration: 0,
          hostMessageId: "after-lease-1",
          role: "user",
          content: "continued once",
          contentHash: sha256Hex("continued once"),
        })
      ),
      secondAdapter.ingestHarnessEvent({
        workspaceId: WS_A,
        provenance: {
          actorId: "key:test",
          actorType: "api_key",
          userId: null,
          sensitivityCeiling: "internal",
        },
        event: hashEvent({
          ...common,
          eventId: `${leasedSource}-append-2`,
          hostSessionId: leasedSource,
          enqueueSequence: 3,
          type: "turn.append",
          sourceGeneration: 0,
          hostMessageId: "after-lease-2",
          role: "assistant",
          content: "continued twice",
          contentHash: sha256Hex("continued twice"),
        }),
        receivedAt: new Date(), // determinism-ok: ingestion timestamp is the caller's wall clock; the assertion never depends on its value
      }),
    ]);
    const successors = await raw<Array<{ id: string; predecessor_session_id: string }>>`
      SELECT id, predecessor_session_id FROM mnemosyne.mnemo_session
      WHERE workspace_id = ${WS_A} AND predecessor_session_id = ${leased}
    `;
    expect(successors).toHaveLength(1);
    expect(await adapter.listTurns(successors[0]!.id, WS_A)).toHaveLength(2);
  });

  it("creates a successor after an expired provisional lease is released", async () => {
    const source = `expired-lifecycle-source-${++sessionSequence}`;
    const common = {
      host: "opencode" as const,
      clientInstanceId: "expired-lifecycle-client",
      hostSessionId: source,
      occurredAt: new Date().toISOString(), // determinism-ok: ingestion timestamp is the caller's wall clock; the assertion never depends on its value
      normalizationVersion: 1 as const,
    };
    const start = await ingest(
      hashEvent({
        ...common,
        eventId: `${source}-start`,
        enqueueSequence: 1,
        type: "session.start",
      })
    );
    const original = start.sessionId!;
    await raw`
      UPDATE mnemosyne.mnemo_session
      SET status = 'collapse_pending', close_kind = 'provisional',
          close_requested_at = NOW(), close_grace_deadline = NOW() - interval '1 second',
          collapse_lease_owner = 'expired-worker',
          collapse_lease_expires_at = NOW() - interval '1 second'
      WHERE id = ${original}
    `;
    expect(await adapter.releaseExpiredManagedLeases({ workspaceId: WS_A })).toBe(1);
    await expect(
      adapter.appendTurn(original, {
        workspaceId: WS_A,
        sessionId: original,
        turnIndex: 0,
        role: "user",
        content: "must not reopen directly",
      })
    ).rejects.toMatchObject({ code: "SESSION_CLOSED" });

    const resumed = await ingest(
      hashEvent({
        ...common,
        eventId: `${source}-append`,
        enqueueSequence: 2,
        type: "turn.append",
        sourceGeneration: 0,
        hostMessageId: "after-expired-lease",
        role: "user",
        content: "must use a successor",
        contentHash: sha256Hex("must use a successor"),
      })
    );

    expect(resumed.effectiveGeneration).toBe(1);
    expect((await sessionRow(original)).status).toBe("collapse_pending");
    const successors = await raw<Array<{ id: string }>>`
      SELECT id FROM mnemosyne.mnemo_session
      WHERE workspace_id = ${WS_A} AND predecessor_session_id = ${original}
    `;
    expect(successors).toHaveLength(1);
  });

  it("does not let legacy close or discard terminalize managed sessions", async () => {
    const collapseTarget = await seedManagedSession(WS_A, {
      status: "collapse_pending",
      closeKind: "authoritative",
      closeGraceDeadline: new Date(0),
      leaseOwner: "worker",
      leaseExpiresAt: new Date(Date.now() + 60_000), // determinism-ok: lease deadline is relative to database time by design; the test asserts expiry, not a fixed instant
    });
    const discardTarget = await seedManagedSession(WS_A, {
      status: "collapse_pending",
      closeKind: "authoritative",
      closeGraceDeadline: new Date(0),
      leaseOwner: "worker",
      leaseExpiresAt: new Date(Date.now() + 60_000), // determinism-ok: lease deadline is relative to database time by design; the test asserts expiry, not a fixed instant
    });

    await adapter.closeSession(collapseTarget, WS_A);
    await adapter.archiveSession(discardTarget, WS_A);

    expect((await sessionRow(collapseTarget)).status).toBe("collapse_pending");
    expect((await sessionRow(discardTarget)).status).toBe("collapse_pending");
  });

  it("allows an archived legacy session to complete an explicit re-collapse", async () => {
    const session = await adapter.createSession({ workspaceId: WS_A });
    await adapter.archiveSession(session.id, WS_A);
    expect((await sessionRow(session.id)).status).toBe("archived");

    await adapter.closeSession(session.id, WS_A);

    expect((await sessionRow(session.id)).status).toBe("collapsed");

    await adapter.archiveSession(session.id, WS_A);

    expect((await sessionRow(session.id)).status).toBe("archived");
  });

  it("rejects direct writes to terminal generations", async () => {
    const collapsed = await seedManagedSession(WS_A, { status: "collapsed" });
    const archived = await seedManagedSession(WS_A, {
      status: "archived",
      archiveReason: "empty_session",
    });
    await expect(
      adapter.appendTurn(collapsed, {
        workspaceId: WS_A,
        sessionId: collapsed,
        turnIndex: 0,
        role: "user",
        content: "must fail",
      })
    ).rejects.toMatchObject({ code: "SESSION_TERMINAL" });
    expect(
      await adapter.replaceSessionScratch({
        workspaceId: WS_A,
        sessionId: archived,
        scratch: { x: 1 },
      })
    ).toBe(false);
  });

  it("fences managed pin mutations once authoritative, leased, or terminal", async () => {
    const cases = [
      { status: "collapse_pending" as const, closeKind: "authoritative" as const },
      {
        status: "collapse_pending" as const,
        closeKind: "provisional" as const,
        leaseOwner: "worker",
        leaseExpiresAt: new Date(Date.now() + 60_000), // determinism-ok: lease deadline is relative to database time by design; the test asserts expiry, not a fixed instant
      },
      { status: "collapsed" as const },
      { status: "archived" as const, archiveReason: "empty_session" },
    ];
    for (const lifecycle of cases) {
      const id = await seedManagedSession(WS_A, lifecycle);
      await raw`
        INSERT INTO mnemosyne.mnemo_session_turn
          (workspace_id, session_id, turn_index, role, content, pinned)
        VALUES (${WS_A}::uuid, ${id}, 0, 'user', 'immutable collapse input', false)
      `;
      await expect(
        adapter.pinSessionTurn({
          workspaceId: WS_A,
          sessionId: id,
          turnIndex: 0,
          pinned: true,
        })
      ).rejects.toMatchObject({ code: "SESSION_CLOSED" });
    }
  });

  it("allows managed pin mutation only for an unleased provisional close", async () => {
    const id = await seedManagedSession(WS_A, {
      status: "collapse_pending",
      closeKind: "provisional",
      closeGraceDeadline: new Date(Date.now() + 60_000), // determinism-ok: wall-clock value the assertion does not depend on
    });
    await raw`
      INSERT INTO mnemosyne.mnemo_session_turn
        (workspace_id, session_id, turn_index, role, content, pinned)
      VALUES (${WS_A}::uuid, ${id}, 0, 'user', 'still mutable', false)
    `;

    expect(
      await adapter.pinSessionTurn({
        workspaceId: WS_A,
        sessionId: id,
        turnIndex: 0,
        pinned: true,
      })
    ).toBe(true);
  });

  it("retries only enumerated legacy archives without reopening writes", async () => {
    const recoverable = await Promise.all(
      ["too_few_turns", "low_recurrence_signal", "no_pin"].map((reason) =>
        seedManagedSession(WS_A, { status: "archived", archiveReason: reason })
      )
    );
    const permanent = await seedManagedSession(WS_A, {
      status: "archived",
      archiveReason: "empty_session",
    });
    for (const id of recoverable) {
      expect(await adapter.retryLegacyManagedArchive({ workspaceId: WS_A, sessionId: id })).toBe(
        true
      );
      expect((await sessionRow(id)).status).toBe("collapse_pending");
      await expect(
        adapter.appendTurn(id, {
          workspaceId: WS_A,
          sessionId: id,
          turnIndex: 0,
          role: "user",
          content: "still closed for writes",
        })
      ).rejects.toMatchObject({ code: "SESSION_CLOSED" });
    }
    expect(
      await adapter.retryLegacyManagedArchive({ workspaceId: WS_A, sessionId: permanent })
    ).toBe(false);
  });

  it("reuses an existing finalized archive operation during recoverable retry", async () => {
    const id = await seedManagedSession(WS_A, {
      status: "collapse_pending",
      closeKind: "authoritative",
      closeGraceDeadline: new Date(0),
      leaseOwner: "first-worker",
      leaseExpiresAt: new Date(Date.now() + 60_000), // determinism-ok: lease deadline is relative to database time by design; the test asserts expiry, not a fixed instant
    });
    const operationId = `archive:${id}`;
    expect(
      await adapter.finalizeManagedArchive({
        workspaceId: WS_A,
        sessionId: id,
        leaseOwner: "first-worker",
        operationId,
        reason: "no_pin",
      })
    ).toBe(true);
    await raw`
      UPDATE mnemosyne.mnemo_managed_collapse_effect
      SET status = 'completed', attempts = 3, completed_at = NOW(),
          next_attempt_at = NOW(), last_error = 'old failure'
      WHERE collapse_operation_id = ${operationId}
    `;
    expect(await adapter.retryLegacyManagedArchive({ workspaceId: WS_A, sessionId: id })).toBe(
      true
    );
    const [claim] = await adapter.claimManagedSessions({
      workspaceId: WS_A,
      leaseOwner: "retry-worker",
      limit: 1,
      inactivityMs: 60_000,
      provisionalGraceMs: 1_000,
      leaseMs: 30_000,
    });
    expect(claim?.session.collapseOperationId).toBe(operationId);

    await expect(
      adapter.finalizeManagedArchive({
        workspaceId: WS_A,
        sessionId: id,
        leaseOwner: "retry-worker",
        operationId,
        reason: "no_pin",
      })
    ).resolves.toBe(true);
    const effects = await raw<
      Array<{
        effect_kind: string;
        status: string;
        attempts: number;
        completed_at: Date | null;
        next_attempt_at: Date | null;
        last_error: string | null;
      }>
    >`
      SELECT effect_kind, status, attempts, completed_at, next_attempt_at, last_error
      FROM mnemosyne.mnemo_managed_collapse_effect
      WHERE collapse_operation_id = ${operationId}
      ORDER BY effect_kind
    `;
    expect(effects).toHaveLength(3);
    expect(effects).toEqual([
      {
        effect_kind: "lifecycle_event",
        status: "pending",
        attempts: 0,
        completed_at: null,
        next_attempt_at: null,
        last_error: null,
      },
      {
        effect_kind: "metrics",
        status: "pending",
        attempts: 0,
        completed_at: null,
        next_attempt_at: null,
        last_error: null,
      },
      {
        effect_kind: "redis_cleanup",
        status: "pending",
        attempts: 0,
        completed_at: null,
        next_attempt_at: null,
        last_error: null,
      },
    ]);
  });

  it("returns false when concurrent recovery uses a different operation id", async () => {
    const id = await seedManagedSession(WS_A, {
      status: "collapse_pending",
      closeKind: "authoritative",
      closeGraceDeadline: new Date(0),
      leaseOwner: "first-worker",
      leaseExpiresAt: new Date(Date.now() + 60_000), // determinism-ok: lease deadline is relative to database time by design; the test asserts expiry, not a fixed instant
    });
    const operationId = `archive:${id}`;
    expect(
      await adapter.finalizeManagedArchive({
        workspaceId: WS_A,
        sessionId: id,
        leaseOwner: "first-worker",
        operationId,
        reason: "no_pin",
      })
    ).toBe(true);
    expect(await adapter.retryLegacyManagedArchive({ workspaceId: WS_A, sessionId: id })).toBe(
      true
    );
    await adapter.claimManagedSessions({
      workspaceId: WS_A,
      leaseOwner: "retry-worker",
      limit: 1,
      inactivityMs: 60_000,
      provisionalGraceMs: 1_000,
      leaseMs: 30_000,
    });

    const results = await Promise.allSettled([
      secondAdapter.finalizeManagedArchive({
        workspaceId: WS_A,
        sessionId: id,
        leaseOwner: "retry-worker",
        operationId: `replacement:${id}`,
        reason: "no_pin",
      }),
      adapter.finalizeManagedArchive({
        workspaceId: WS_A,
        sessionId: id,
        leaseOwner: "retry-worker",
        operationId,
        reason: "no_pin",
      }),
    ]);

    expect(results).toEqual([
      { status: "fulfilled", value: false },
      { status: "fulfilled", value: true },
    ]);
    const effects = await raw<Array<{ effect_kind: string }>>`
      SELECT effect_kind
      FROM mnemosyne.mnemo_managed_collapse_effect
      WHERE collapse_operation_id = ${operationId}
      ORDER BY effect_kind
    `;
    expect(effects).toEqual([
      { effect_kind: "lifecycle_event" },
      { effect_kind: "metrics" },
      { effect_kind: "redis_cleanup" },
    ]);
  });

  it("rejects unknown archive reasons while preserving expand-only compatibility", async () => {
    await expect(
      seedManagedSession(WS_A, { status: "archived", archiveReason: "llm_unavailable" })
    ).rejects.toThrow();
    // Pre-lifecycle servers do not write archive metadata on status changes.
    await expect(seedManagedSession(WS_A, { status: "archived" })).resolves.toBeDefined();

    const legacy = await adapter.createSession({ workspaceId: WS_A });
    await adapter.archiveSession(legacy.id, WS_A);
    expect((await sessionRow(legacy.id)).archive_reason).toBeNull();
  });

  it("does not archive a session with another session's operation id", async () => {
    const operationId = "shared-archive-operation";
    const first = await seedManagedSession(WS_A, {
      status: "collapse_pending",
      closeKind: "authoritative",
      closeGraceDeadline: new Date(0),
      leaseOwner: "first-worker",
      leaseExpiresAt: new Date(Date.now() + 60_000), // determinism-ok: lease deadline is relative to database time by design; the test asserts expiry, not a fixed instant
    });
    const second = await seedManagedSession(WS_A, {
      status: "collapse_pending",
      closeKind: "authoritative",
      closeGraceDeadline: new Date(0),
      leaseOwner: "second-worker",
      leaseExpiresAt: new Date(Date.now() + 60_000), // determinism-ok: lease deadline is relative to database time by design; the test asserts expiry, not a fixed instant
    });
    expect(
      await adapter.finalizeManagedArchive({
        workspaceId: WS_A,
        sessionId: first,
        leaseOwner: "first-worker",
        operationId,
        reason: "empty_session",
      })
    ).toBe(true);

    expect(
      await adapter.finalizeManagedArchive({
        workspaceId: WS_A,
        sessionId: second,
        leaseOwner: "second-worker",
        operationId,
        reason: "empty_session",
      })
    ).toBe(false);
    expect((await sessionRow(second)).status).toBe("collapse_pending");
  });

  it("archives status, timestamp, reason, lifecycle and terminal effects atomically", async () => {
    const id = await seedManagedSession(WS_A, {
      status: "collapse_pending",
      closeKind: "authoritative",
      closeGraceDeadline: new Date(0),
      leaseOwner: "owner",
      leaseExpiresAt: new Date(Date.now() + 60_000), // determinism-ok: lease deadline is relative to database time by design; the test asserts expiry, not a fixed instant
    });
    const operationId = `archive:${id}`;
    expect(
      await adapter.finalizeManagedArchive({
        workspaceId: WS_A,
        sessionId: id,
        leaseOwner: "owner",
        operationId,
        reason: "incomplete_exchange",
      })
    ).toBe(true);

    const row = await sessionRow(id);
    expect(row.status).toBe("archived");
    expect(row.archive_reason).toBe("incomplete_exchange");
    expect(row.archived_at).toBeInstanceOf(Date);
    expect(row.collapse_operation_id).toBe(operationId);
    const effects = await raw<Array<{ effect_kind: string; status: string }>>`
      SELECT effect_kind, status FROM mnemosyne.mnemo_managed_collapse_effect
      WHERE workspace_id = ${WS_A} AND collapse_operation_id = ${operationId}
      ORDER BY effect_kind
    `;
    expect(effects).toEqual([
      { effect_kind: "lifecycle_event", status: "pending" },
      { effect_kind: "metrics", status: "pending" },
      { effect_kind: "redis_cleanup", status: "pending" },
    ]);
  });

  it("quiesces only unleased pending sessions after ingestion is disabled and reports counts", async () => {
    const unleased = await seedManagedSession(WS_A, {
      status: "collapse_pending",
      closeKind: "provisional",
      closeGraceDeadline: new Date(0),
    });
    const leased = await seedManagedSession(WS_A, {
      status: "collapse_pending",
      closeKind: "authoritative",
      closeGraceDeadline: new Date(0),
      leaseOwner: "worker",
      leaseExpiresAt: new Date(Date.now() + 60_000), // determinism-ok: lease deadline is relative to database time by design; the test asserts expiry, not a fixed instant
    });
    await raw`
      UPDATE mnemosyne.mnemo_harness_workspace_control
      SET ingestion_enabled = false WHERE workspace_id = ${WS_A}
    `;
    const result = await adapter.quiesceManagedLifecycle({ workspaceId: WS_A });
    expect(result).toEqual({ pendingCount: 1, liveLeaseCount: 1, reactivatedCount: 1 });
    expect((await sessionRow(unleased)).status).toBe("active");
    expect((await sessionRow(leased)).status).toBe("collapse_pending");
  });

  it("reclaims expired leases during quiesce and returns post-transition counts", async () => {
    const expired = await seedManagedSession(WS_A, {
      status: "collapse_pending",
      closeKind: "provisional",
      closeGraceDeadline: new Date(0),
      leaseOwner: "expired-owner",
      leaseExpiresAt: new Date(Date.now() - 1_000), // determinism-ok: lease deadline is relative to database time by design; the test asserts expiry, not a fixed instant
    });
    await raw`
      UPDATE mnemosyne.mnemo_harness_workspace_control
      SET ingestion_enabled = false WHERE workspace_id = ${WS_A}
    `;

    expect(await adapter.quiesceManagedLifecycle({ workspaceId: WS_A })).toEqual({
      pendingCount: 0,
      liveLeaseCount: 0,
      reactivatedCount: 1,
    });
    expect((await sessionRow(expired)).status).toBe("active");
    expect((await sessionRow(expired)).collapse_lease_owner).toBeNull();
  });

  it("uses the server clock for scratch activity without changing counters or digest fields", async () => {
    const old = new Date("2000-01-01T00:00:00.000Z");
    const id = await seedManagedSession(WS_A, { lastActivityAt: old });
    await raw`
      UPDATE mnemosyne.mnemo_session
      SET turn_count = 4, token_count = 99, terminal_message_set_digest = ${"d".repeat(64)},
          terminal_max_enqueue_sequence = 7
      WHERE id = ${id}
    `;
    const [{ server_now: serverNow }] = await raw<Array<{ server_now: Date }>>`
      SELECT transaction_timestamp() AS server_now
    `;
    expect(
      await adapter.replaceSessionScratch({
        workspaceId: WS_A,
        sessionId: id,
        scratch: { note: true },
      })
    ).toBe(true);
    const row = await sessionRow(id);
    expect((row.last_activity_at as Date).getTime()).toBeGreaterThanOrEqual(serverNow.getTime());
    expect(row.turn_count).toBe(4);
    expect(row.token_count).toBe(99);
    expect(row.terminal_message_set_digest).toBe("d".repeat(64));
    expect(Number(row.terminal_max_enqueue_sequence)).toBe(7);
  });

  it("maps every turn field while collapse projection excludes retracted and non-dialogue turns", async () => {
    const id = await seedManagedSession();
    await raw`
      INSERT INTO mnemosyne.mnemo_session_turn
        (workspace_id, session_id, turn_index, role, content, token_count, pinned, hint,
         source_message_id, supersedes_source_message_id, content_hash, retracted_at,
         retraction_reason, ingestion_event_workspace_id)
      VALUES
        (${WS_A}::uuid, ${id}, 0, 'user', 'visible', 2, true, 'keep',
         'm1', NULL, ${"1".repeat(64)}, NULL, NULL, ${WS_A}),
        (${WS_A}::uuid, ${id}, 1, 'assistant', 'retracted', 3, false, 'old',
         'm2', 'm0', ${"2".repeat(64)}, NOW(), 'superseded', ${WS_A}),
        (${WS_A}::uuid, ${id}, 2, 'system', 'hidden', 4, false, NULL,
         NULL, NULL, NULL, NULL, NULL, ${WS_A}),
        (${WS_A}::uuid, ${id}, 3, 'assistant', 'answer', 5, false, NULL,
         'm3', NULL, ${"3".repeat(64)}, NULL, NULL, ${WS_A})
    `;

    const all = await adapter.listTurns(id, WS_A);
    expect(all).toHaveLength(4);
    expect(all[0]).toMatchObject({
      pinned: true,
      hint: "keep",
      sourceMessageId: "m1",
      contentHash: "1".repeat(64),
      retractedAt: undefined,
    });
    expect(all[1]).toMatchObject({
      supersedesSourceMessageId: "m0",
      retractionReason: "superseded",
    });
    expect(all[1]!.retractedAt).toBeInstanceOf(Date);

    const collapseTurns = await adapter.listManagedCollapseTurns(id, WS_A);
    expect(collapseTurns.map((turn) => turn.content)).toEqual(["visible", "answer"]);
  });
});
