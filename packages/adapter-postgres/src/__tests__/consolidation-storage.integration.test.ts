import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import postgres from "postgres";

import { createDrizzleClient, DrizzleStorageAdapter } from "../DrizzleStorageAdapter.js";
import { migrate } from "../migrate.js";

const PG_IMAGE = "pgvector/pgvector:pg17";
const PG_USER = "mnemo_super";
const PG_PASS = "mnemo_super";
const PG_DB = "mnemo_test";
const APP_USER = "consolidation_app";
const APP_PASS = "consolidation_app_pass";
const WS_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WS_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const EXPIRED = new Date("2026-07-17T12:15:00.000Z");

type WorthSnapshot = { alpha: number; beta: number; success: number; failure: number };
type MergeSnapshot = {
  operationId: string;
  workspaceId: string;
  survivorId: string;
  absorbedFactIds: string[];
  previousWorth: WorthSnapshot;
  expectedMergedWorth: WorthSnapshot;
};
type ConsolidationStorage = {
  applyConsolidationMerge(input: {
    operationId: string;
    workspaceId: string;
    survivorId: string;
    absorbedFactIds: string[];
    leaseExpiresAt: Date;
  }): Promise<MergeSnapshot | null>;
  rollbackConsolidationMerge(input: {
    snapshot: MergeSnapshot;
    review: {
      reason: "replay_validation_failed" | "replay_execution_failed";
      passCount: number;
      failCount: number;
      queriesUsed: string[];
    };
  }): Promise<"rolled_back" | "conflict">;
  finalizeConsolidationMerge(input: {
    snapshot: MergeSnapshot;
    applyReplayBoost: boolean;
  }): Promise<"finalized" | "conflict">;
  inspectConsolidationMergeState(
    snapshot: MergeSnapshot
  ): Promise<"pending" | "restored" | "retained" | "divergent">;
  recoverExpiredConsolidationMerges(input: {
    workspaceId: string;
    expiredBefore: Date;
  }): Promise<number>;
  updateFact(id: string, workspaceId: string, input: Record<string, unknown>): Promise<unknown>;
  setCanonical(id: string, workspaceId: string, canonical: boolean): Promise<void>;
  updateWorth(
    id: string,
    workspaceId: string,
    kind: string,
    delta: { success: number; failure: number; creditWeight: number }
  ): Promise<void>;
  decayKind(workspaceId: string, decayClass: string, halfLifeDays: number): Promise<number>;
  purgeFacts(filter: {
    workspaceId: string;
    sensitivity: string;
    olderThanDays: number;
    dryRun: boolean;
  }): Promise<{ softClosed: number }>;
  replaceFact(input: {
    id: string;
    workspaceId: string;
    statement: string;
    requestedBy: string;
  }): Promise<unknown>;
  archiveFact(id: string, workspaceId: string): Promise<void>;
  hardDeleteFact(id: string, workspaceId: string): Promise<void>;
};

let container: StartedTestContainer;
let superSql: ReturnType<typeof postgres>;
let appClient: ReturnType<typeof createDrizzleClient>;
let storage: ConsolidationStorage;

async function seedCluster(prefix: string, workspaceId: string) {
  await superSql`
    INSERT INTO mnemosyne.mnemo_fact
      (id, workspace_id, scope, kind, subject, statement, metadata,
       worth_alpha, worth_beta, worth_success, worth_failure)
    VALUES
      (${`${prefix}-survivor`}, ${workspaceId}, 'global', 'other', ${`${prefix}-subject`}, ${`${prefix} survivor`},
       ${superSql.json({ survivor: "kept" })}, 2.1250, 3.3750, 0.1250, 1.3750),
      (${`${prefix}-absorbed-a`}, ${workspaceId}, 'global', 'other', ${`${prefix}-subject`}, ${`${prefix} absorbed a`},
       ${superSql.json({ absorbedA: "kept" })}, 2.0000, 2.0000, 0.0000, 0.0000),
      (${`${prefix}-absorbed-b`}, ${workspaceId}, 'global', 'other', ${`${prefix}-subject`}, ${`${prefix} absorbed b`},
       ${superSql.json({ absorbedB: "kept" })}, 2.0000, 2.0000, 0.0000, 0.0000)
  `;
  return {
    survivorId: `${prefix}-survivor`,
    absorbedFactIds: [`${prefix}-absorbed-b`, `${prefix}-absorbed-a`],
  };
}

beforeAll(async () => {
  container = await new GenericContainer(PG_IMAGE)
    .withEnvironment({ POSTGRES_USER: PG_USER, POSTGRES_PASSWORD: PG_PASS, POSTGRES_DB: PG_DB })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
    .start();
  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const superUrl = `postgres://${PG_USER}:${PG_PASS}@${host}:${port}/${PG_DB}`;
  const appUrl = `postgres://${APP_USER}:${APP_PASS}@${host}:${port}/${PG_DB}`;

  await migrate({ databaseUrl: superUrl, log: () => void 0 });
  superSql = postgres(superUrl, { max: 1, onnotice: () => void 0 });
  await superSql.unsafe(`
    CREATE ROLE ${APP_USER} LOGIN PASSWORD '${APP_PASS}'
      NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
    GRANT mnemo_app_role TO ${APP_USER};
    GRANT CONNECT ON DATABASE ${PG_DB} TO ${APP_USER};
    GRANT USAGE ON SCHEMA mnemosyne TO ${APP_USER};
  `);
  const roleRows = await superSql<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>`
    SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = ${APP_USER}
  `;
  expect(roleRows).toEqual([{ rolsuper: false, rolbypassrls: false }]);

  appClient = createDrizzleClient(appUrl);
  storage = new DrizzleStorageAdapter(
    appClient.db,
    appClient.pgClient
  ) as unknown as ConsolidationStorage;
}, 120_000);

afterAll(async () => {
  await appClient?.pgClient.end().catch(() => void 0);
  await superSql?.end().catch(() => void 0);
  await container?.stop().catch(() => void 0);
});

describe("atomic consolidation storage under FORCE RLS", () => {
  it("applies and finalizes with exact decimal snapshots", async () => {
    const cluster = await seedCluster("finalize", WS_A);
    const snapshot = await storage.applyConsolidationMerge({
      operationId: "operation-finalize",
      workspaceId: WS_A,
      ...cluster,
      leaseExpiresAt: new Date("2026-07-17T12:30:00.000Z"),
    });

    expect(snapshot).toMatchObject({
      previousWorth: { alpha: 2.125, beta: 3.375, success: 0.125, failure: 1.375 },
      expectedMergedWorth: { alpha: 3.125, beta: 3.375, success: 1.125, failure: 1.375 },
    });
    await expect(storage.inspectConsolidationMergeState(snapshot!)).resolves.toBe("pending");
    await expect(
      storage.finalizeConsolidationMerge({ snapshot: snapshot!, applyReplayBoost: true })
    ).resolves.toBe("finalized");
    await expect(storage.inspectConsolidationMergeState(snapshot!)).resolves.toBe("retained");
  });

  it("never closes an absorbed row before its own valid_from (final review M2)", async () => {
    // A row created after the merge transaction began starts after
    // transaction_timestamp(); the close must land at its start, not before it
    // (tstzrange refuses an interval that ends before it begins). Moving
    // valid_from 5 s ahead stands in for that race deterministically.
    const cluster = await seedCluster("late-start", WS_A);
    await superSql`
      UPDATE mnemosyne.mnemo_fact SET valid_from = now() + interval '5 seconds'
      WHERE id = ${cluster.absorbedFactIds[0]!}
    `;
    const snapshot = await storage.applyConsolidationMerge({
      operationId: "operation-late-start",
      workspaceId: WS_A,
      ...cluster,
      leaseExpiresAt: new Date("2026-07-17T12:30:00.000Z"),
    });
    expect(snapshot).not.toBeNull();
    const rows = await superSql<Array<{ id: string; ok: boolean }>>`
      SELECT id, valid_to >= valid_from AS ok FROM mnemosyne.mnemo_fact
      WHERE id IN (${cluster.absorbedFactIds[0]!}, ${cluster.absorbedFactIds[1]!}) ORDER BY id
    `;
    expect(rows.map((r) => r.ok)).toEqual([true, true]);
  });

  it("rolls back exactly, inserts the authoritative raw review row, and emits no outbox", async () => {
    const cluster = await seedCluster("rollback", WS_A);
    const snapshot = await storage.applyConsolidationMerge({
      operationId: "operation-rollback",
      workspaceId: WS_A,
      ...cluster,
      leaseExpiresAt: new Date("2026-07-17T12:30:00.000Z"),
    });
    const [{ count: outboxBefore }] = await superSql<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM mnemosyne.mnemo_outbox WHERE workspace_id = ${WS_A}::uuid
    `;

    await expect(
      storage.rollbackConsolidationMerge({
        snapshot: snapshot!,
        review: {
          reason: "replay_validation_failed",
          passCount: 2,
          failCount: 3,
          queriesUsed: ["q1", "q2", "q3", "q4", "q5"],
        },
      })
    ).resolves.toBe("rolled_back");

    const facts = await superSql<
      Array<{
        id: string;
        status: string;
        valid_to: Date | null;
        merged_into_id: string | null;
        metadata: Record<string, unknown>;
        worth_alpha: string;
        worth_beta: string;
        worth_success: string;
        worth_failure: string;
      }>
    >`
      SELECT id, status, valid_to, merged_into_id, metadata,
             worth_alpha::text, worth_beta::text, worth_success::text, worth_failure::text
      FROM mnemosyne.mnemo_fact
      WHERE id IN (${cluster.survivorId}, ${cluster.absorbedFactIds[0]!}, ${cluster.absorbedFactIds[1]!})
      ORDER BY id
    `;
    expect(facts).toEqual([
      expect.objectContaining({
        id: "rollback-absorbed-a",
        status: "active",
        valid_to: null,
        merged_into_id: null,
        metadata: { absorbedA: "kept" },
      }),
      expect.objectContaining({
        id: "rollback-absorbed-b",
        status: "active",
        valid_to: null,
        merged_into_id: null,
        metadata: { absorbedB: "kept" },
      }),
      expect.objectContaining({
        id: "rollback-survivor",
        status: "active",
        valid_to: null,
        metadata: { survivor: "kept" },
        worth_alpha: "2.1250",
        worth_beta: "3.3750",
        worth_success: "0.1250",
        worth_failure: "1.3750",
      }),
    ]);
    const reviews = await superSql<
      Array<{ id: string; workspace_id: string; fact_id: string; reason: string }>
    >`
      SELECT id, workspace_id, fact_id, reason
      FROM mnemosyne.mnemo_review_queue
      WHERE fact_id = ${cluster.survivorId}
    `;
    expect(reviews).toEqual([
      {
        id: expect.stringMatching(/^mrev_/),
        workspace_id: WS_A,
        fact_id: cluster.survivorId,
        reason: "manual",
      },
    ]);
    const [{ count: outboxAfter }] = await superSql<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM mnemosyne.mnemo_outbox WHERE workspace_id = ${WS_A}::uuid
    `;
    expect(outboxAfter).toBe(outboxBefore);
  });

  it("recovers equality-expired operations and leaves another workspace isolated", async () => {
    const expired = await seedCluster("expired", WS_A);
    const other = await seedCluster("other", WS_B);
    const snapshot = await storage.applyConsolidationMerge({
      operationId: "operation-expired",
      workspaceId: WS_A,
      ...expired,
      leaseExpiresAt: EXPIRED,
    });

    await expect(
      storage.applyConsolidationMerge({
        operationId: "cross-workspace",
        workspaceId: WS_A,
        ...other,
        leaseExpiresAt: EXPIRED,
      })
    ).resolves.toBeNull();
    await expect(
      storage.recoverExpiredConsolidationMerges({ workspaceId: WS_A, expiredBefore: EXPIRED })
    ).resolves.toBe(1);
    await expect(storage.inspectConsolidationMergeState(snapshot!)).resolves.toBe("restored");

    const otherRows = await superSql<
      Array<{ status: string; valid_to: Date | null; metadata: Record<string, unknown> }>
    >`
      SELECT status, valid_to, metadata
      FROM mnemosyne.mnemo_fact
      WHERE workspace_id = ${WS_B} AND id LIKE 'other-%'
      ORDER BY id
    `;
    expect(otherRows).toHaveLength(3);
    expect(otherRows.every((row) => row.status === "active" && row.valid_to === null)).toBe(true);
    expect(otherRows.every((row) => !("__mnemoConsolidationPending" in row.metadata))).toBe(true);
  });

  it("generic writers no-op on a pending fact under NOSUPERUSER NOBYPASSRLS", async () => {
    const cluster = await seedCluster("guard", WS_A);
    const snapshot = await storage.applyConsolidationMerge({
      operationId: "operation-guard",
      workspaceId: WS_A,
      ...cluster,
      leaseExpiresAt: new Date("2026-07-17T12:30:00.000Z"),
    });
    expect(snapshot).not.toBeNull();
    const survivorId = cluster.survivorId;

    // updateFact({ pinned }) → returns null, leaves pinned unchanged.
    await expect(storage.updateFact(survivorId, WS_A, { pinned: true })).resolves.toBeNull();

    // updateFact metadata cannot spoof/erase the genuine marker.
    await storage.updateFact(survivorId, WS_A, {
      metadata: { extra: "field", __mnemoConsolidationPending: { operationId: "spoofed" } },
    });

    // setCanonical → no-op.
    await storage.setCanonical(survivorId, WS_A, true);

    // updateWorth('fact') → no-op on worth fields.
    await storage.updateWorth(survivorId, WS_A, "fact", {
      success: 9,
      failure: 0,
      creditWeight: 1,
    });

    // decayKind('semantic') → skips the pending survivor.
    await storage.decayKind(WS_A, "semantic", 58);

    // archiveFact → no-op.
    await storage.archiveFact(survivorId, WS_A);

    // replaceFact → returns null.
    await expect(
      storage.replaceFact({
        id: survivorId,
        workspaceId: WS_A,
        statement: "usurped",
        requestedBy: "user-1",
      })
    ).resolves.toBeNull();

    // hardDeleteFact → row still present.
    await storage.hardDeleteFact(survivorId, WS_A);

    // Age past retention + purge → excludes the pending row.
    await superSql`
      UPDATE mnemosyne.mnemo_fact
      SET created_at = now() - interval '800 days', sensitivity = 'internal'
      WHERE id = ${survivorId}
    `;
    const purge = await storage.purgeFacts({
      workspaceId: WS_A,
      sensitivity: "internal",
      olderThanDays: 730,
      dryRun: false,
    });

    const [row] = await superSql<
      Array<{
        status: string;
        pinned: boolean;
        canonical: boolean;
        valid_to: Date | null;
        metadata: Record<string, unknown>;
        worth_alpha: string;
        worth_success: string;
      }>
    >`
      SELECT status, pinned, canonical, valid_to, metadata,
             worth_alpha::text, worth_success::text
      FROM mnemosyne.mnemo_fact WHERE id = ${survivorId}
    `;
    // Row survived every generic writer, still pending, still active.
    expect(row).toBeDefined();
    expect(row!.status).toBe("active");
    expect(row!.valid_to).toBeNull();
    expect(row!.pinned).toBe(false);
    expect(row!.canonical).toBe(false);
    // Genuine marker preserved; spoof rejected. (updateFact replaces the whole
    // metadata blob, so the prior `survivor` key is legitimately gone — but the
    // genuine marker is atomically reattached and the spoof value is dropped.)
    expect(row!.metadata.__mnemoConsolidationPending).toMatchObject({
      operationId: "operation-guard",
    });
    expect(row!.metadata).toMatchObject({ extra: "field" });
    // Worth snapshot intact (survivor after merge: alpha 3.125, success 1.125).
    expect(row!.worth_alpha).toBe("3.1250");
    expect(row!.worth_success).toBe("1.1250");
    // Purge closed nothing (only the pending row matched the age/sensitivity filter).
    expect(purge.softClosed).toBe(0);

    // The operation can still finalize cleanly afterwards.
    await expect(storage.inspectConsolidationMergeState(snapshot!)).resolves.toBe("pending");
  });

  it("materialiseInference strips a forged marker from the derived fact", async () => {
    const rule = await (
      storage as unknown as {
        createCompositionRule(input: {
          workspaceId: string;
          name: string;
          conditionDsl: unknown;
          actionDsl: unknown;
        }): Promise<{ id: string }>;
      }
    ).createCompositionRule({
      workspaceId: WS_A,
      name: "guard-rule",
      conditionDsl: {},
      actionDsl: {},
    });
    const { id } = await (
      storage as unknown as {
        materialiseInference(input: unknown): Promise<{ id: string }>;
      }
    ).materialiseInference({
      ruleId: rule.id,
      workspaceId: WS_A,
      fact: {
        scope: "global",
        kind: "other",
        subject: "derived",
        statement: "derived guard statement",
        attribution: "inferred",
        sensitivity: "internal",
        metadata: { keep: "yes", __mnemoConsolidationPending: { operationId: "forged" } },
      },
      inferenceLog: {
        inputFactIds: ["a", "b"],
        derivedKind: "fact",
        confidence: 0.7,
        rationale: "because",
      },
    });
    const [derived] = await superSql<Array<{ metadata: Record<string, unknown> }>>`
      SELECT metadata FROM mnemosyne.mnemo_fact WHERE id = ${id}
    `;
    expect(derived!.metadata).toMatchObject({ keep: "yes" });
    expect(derived!.metadata).not.toHaveProperty("__mnemoConsolidationPending");
  });
});
