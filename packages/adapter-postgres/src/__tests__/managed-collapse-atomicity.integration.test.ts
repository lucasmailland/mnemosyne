import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import postgres from "postgres";
import {
  canonicalJson,
  sha256Hex,
  type HarnessEvent,
  type ManagedPreparedCollapsePlan,
  type ManagedSessionProvenance,
} from "../../../types/src/index.js";
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
  raw = postgres(databaseUrl, {
    onnotice: () => undefined,
    max: 10,
    connection: { search_path: "mnemosyne,public" },
  });
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
  const id = `managed-atomic-${sessionSequence}`;
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
      'internal', 'key:test', 'agent', 'internal', ${values.leaseOwner ?? null},
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

function planFor(sessionId: string): ManagedPreparedCollapsePlan {
  const operationId = `managed:${WS_A}:${sessionId}:0`;
  const sourceMessageIds = ["m-user", "m-assistant"];
  const provenance: ManagedSessionProvenance = {
    actorId: "key:test",
    actorType: "agent",
    userId: null,
    sensitivityCeiling: "internal",
  };
  const common = {
    workspaceId: WS_A,
    actorId: provenance.actorId,
    actorType: "agent" as const,
    sensitivity: "internal" as const,
  };
  return {
    status: "prepared",
    operationId,
    workspaceId: WS_A,
    sessionId,
    generation: 0,
    sourceMessageIds,
    sensitivity: "internal",
    provenance,
    candidates: [
      ...[0, 1, 2].map((n) => ({
        id: `candidate-f${n}`,
        kind: "fact" as const,
        sourceMessageIds,
        sensitivity: "internal" as const,
        topicKey: `topic-${n}`,
        input: {
          ...common,
          scope: "global" as const,
          statement: `Fact ${n}`,
          subject: "project",
          kind: "other" as const,
          confidence: 0.8,
          topicKey: `topic-${n}`,
          sessionId,
          sourceMessageIds,
          extractionSource: "collapse" as const,
        },
      })),
      {
        id: "candidate-d",
        kind: "decision",
        sourceMessageIds,
        sensitivity: "internal",
        topicKey: "decision-topic",
        input: {
          ...common,
          kind: "architecture",
          title: "Decision",
          body: "Use PostgreSQL",
          topicKey: "decision-topic",
        },
      },
      {
        id: "candidate-s",
        kind: "strategy",
        sourceMessageIds,
        sensitivity: "internal",
        input: { ...common, trigger: "When offline", action: "Queue locally" },
      },
    ],
    episode: {
      id: "candidate-episode",
      sourceMessageIds,
      sensitivity: "internal",
      input: {
        ...common,
        title: "Session",
        narrative: "Completed work",
        occurredAt: new Date(), // determinism-ok: ingestion timestamp is the caller's wall clock; the assertion never depends on its value
        sourceConversationId: sessionId,
      },
    },
    rejectedCandidates: [],
    linkSessionFacts: true,
    relations: [
      {
        id: "rel-1",
        sourceId: "candidate-f0",
        sourceType: "fact",
        targetId: "candidate-f1",
        targetType: "fact",
        verb: "related",
      },
    ],
    hyperedges: [
      {
        id: "hyper-1",
        description: "Project facts",
        memberIds: ["candidate-f0", "candidate-f1", "candidate-f2"],
        label: "project",
      },
    ],
    worthUpdates: [{ factId: "candidate-f0", delta: { success: 1, failure: 0, creditWeight: 1 } }],
    counters: { factCount: 3, sessionCount: 1 },
    summary: {
      goal: "Session",
      outcome: "success",
      discoveries: [],
      relevantEntities: [],
      nextSteps: [],
      keyDecisions: [],
      turnsProcessed: 2,
      pinsUsed: 1,
      llmTokensUsed: 100,
      collapseReason: "authoritative",
      episodeId: "candidate-episode",
    },
    indexJobs: [],
    postCommitEffects: [
      {
        effectKind: "session_buffer_cleanup",
        targetKind: "session",
        targetId: sessionId,
        payload: { sessionId },
      },
      {
        effectKind: "bus_delivery",
        targetKind: "session",
        targetId: sessionId,
        payload: { event: "session.collapsed" },
      },
      {
        effectKind: "llm_usage_telemetry",
        targetKind: "session",
        targetId: sessionId,
        payload: { status: "collapsed" },
      },
    ],
  };
}

async function readySession() {
  const id = await seedManagedSession(WS_A, {
    status: "collapse_pending",
    closeKind: "authoritative",
    closeGraceDeadline: new Date(0),
    leaseOwner: "worker",
    leaseExpiresAt: new Date(Date.now() + 60_000), // determinism-ok: lease deadline is relative to database time by design; the test asserts expiry, not a fixed instant
  });
  for (const [index, role] of ["user", "assistant"].entries()) {
    await raw`INSERT INTO mnemosyne.mnemo_session_turn (workspace_id,session_id,turn_index,role,content,source_message_id)
      VALUES (${WS_A}::uuid,${id},${index},${role},'Visible',${`m-${role}`})`;
  }
  return id;
}

function commit(sessionId: string, plan = planFor(sessionId), storage = adapter) {
  return storage.commitManagedCollapse({
    workspaceId: WS_A,
    sessionId,
    generation: 0,
    operationId: plan.operationId,
    leaseOwner: "worker",
    plan,
  });
}

const outputTables = [
  "mnemo_fact",
  "mnemo_decision",
  "mnemo_strategy",
  "mnemo_episode",
  "mnemo_relation",
  "mnemo_hyperedge",
  "mnemo_extraction_provenance",
  "mnemo_managed_collapse_effect",
  "mnemo_outbox",
  "mnemo_managed_collapse_operation",
];
async function counts() {
  const result: Record<string, number> = {};
  for (const table of outputTables) {
    const [row] = await raw.unsafe(
      `SELECT count(*)::int AS n FROM mnemosyne.${table} WHERE workspace_id = $1`,
      [WS_A]
    );
    result[table] = row!.n;
  }
  return result;
}

beforeEach(async () => {
  await raw`TRUNCATE TABLE mnemosyne.mnemo_fact, mnemosyne.mnemo_decision, mnemosyne.mnemo_strategy,
    mnemosyne.mnemo_episode, mnemosyne.mnemo_relation, mnemosyne.mnemo_hyperedge, mnemosyne.mnemo_outbox,
    mnemosyne.mnemo_workspace_mode CASCADE`;
});

describe("managed collapse atomic output", () => {
  it("commits every output once and returns the stored result on concurrent replay", async () => {
    const id = await readySession();
    const plan = planFor(id);
    const first = await commit(id, plan);
    const snapshot = await counts();
    expect(snapshot).toMatchObject({
      mnemo_fact: 3,
      mnemo_decision: 1,
      mnemo_strategy: 1,
      mnemo_episode: 1,
      mnemo_relation: 1,
      mnemo_hyperedge: 1,
      mnemo_extraction_provenance: 6,
      mnemo_managed_collapse_operation: 1,
    });
    expect((await sessionRow(id)).status).toBe("collapsed");
    expect(await Promise.all([commit(id, plan), commit(id, plan, secondAdapter)])).toEqual([
      first,
      first,
    ]);
    expect(await counts()).toEqual(snapshot);
    const facts =
      await raw`SELECT actor_id, actor_type, sensitivity, source_message_ids, episode_id, session_id
      FROM mnemosyne.mnemo_fact WHERE workspace_id=${WS_A}`;
    for (const fact of facts)
      expect(fact).toMatchObject({
        actor_id: "key:test",
        actor_type: "agent",
        sensitivity: "internal",
        source_message_ids: ["m-user", "m-assistant"],
        session_id: id,
        episode_id: first.episodeId,
      });
    const [counter] =
      await raw`SELECT session_count, fact_count FROM mnemosyne.mnemo_workspace_mode WHERE workspace_id=${WS_A}`;
    expect(counter).toMatchObject({ session_count: 1, fact_count: 3 });
  });

  it.each(outputTables)(
    "rolls back all output when %s persistence fails, then succeeds on retry",
    async (table) => {
      const id = await readySession();
      const plan = planFor(id);
      await raw.unsafe(`CREATE OR REPLACE FUNCTION public.fail_managed_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'managed failpoint'; END $$`);
      await raw.unsafe(`CREATE TRIGGER fail_managed_write BEFORE INSERT ON mnemosyne.${table}
      FOR EACH ROW EXECUTE FUNCTION public.fail_managed_write()`);
      try {
        await expect(commit(id, plan)).rejects.toMatchObject({
          cause: expect.objectContaining({ message: "managed failpoint" }),
        });
        expect(await counts()).toEqual(Object.fromEntries(outputTables.map((name) => [name, 0])));
        expect((await sessionRow(id)).status).toBe("collapse_pending");
        const [counter] =
          await raw`SELECT count(*)::int AS n FROM mnemosyne.mnemo_workspace_mode WHERE workspace_id=${WS_A}`;
        expect(counter!.n).toBe(0);
      } finally {
        await raw.unsafe(`DROP TRIGGER fail_managed_write ON mnemosyne.${table}`);
      }
      await expect(commit(id, plan)).resolves.toMatchObject({ status: "collapsed" });
    }
  );

  it("asks for LSH indexing on each managed fact's vector job at insert time", async () => {
    const id = await readySession();
    const plan = planFor(id);
    const result = await commit(id, plan);
    if (result.status !== "collapsed") throw new Error(`Expected collapsed, got ${result.status}`);

    // The managed path has no embedding at insert time, so it cannot enqueue an
    // `lsh_upsert` with precomputed bands the way `remember()` does. It rides the
    // request on the same `vector_upsert` job instead, which also keeps vector +
    // LSH + acknowledgement one atomic retry unit. mnemo_outbox is INSERT-only for
    // mnemo_app_role, so this must be written when the row is created, never patched.
    const factJobs = await raw`SELECT payload FROM mnemosyne.mnemo_outbox
      WHERE workspace_id = ${WS_A}::uuid AND event_type = 'vector_upsert' AND payload->>'kind' = 'fact'`;
    expect(factJobs).toHaveLength(result.factIds.length);
    for (const { payload } of factJobs) {
      expect(payload.indexLsh).toBe(true);
      expect(payload.operationId).toBe(plan.operationId);
      expect(Number.isSafeInteger(payload.revision) && payload.revision >= 1).toBe(true);
    }

    // LSH bands are fact-only (`upsertFactLsh`); a decision's vector job must not ask for them.
    const otherJobs = await raw`SELECT payload FROM mnemosyne.mnemo_outbox
      WHERE workspace_id = ${WS_A}::uuid AND event_type = 'vector_upsert' AND payload->>'kind' <> 'fact'`;
    expect(otherJobs.length).toBeGreaterThan(0);
    for (const { payload } of otherJobs) expect(payload.indexLsh).toBeUndefined();
  });

  it("writes an episode even when no new extraction candidates exist", async () => {
    const id = await readySession();
    const plan = planFor(id);
    plan.candidates = [];
    plan.relations = [];
    plan.hyperedges = [];
    plan.worthUpdates = [];
    plan.counters.factCount = 0;
    const result = await commit(id, plan);
    expect(result.episodeId).toMatch(/^mepi_/);
    expect(await counts()).toMatchObject({
      mnemo_fact: 0,
      mnemo_episode: 1,
      mnemo_extraction_provenance: 1,
    });
  });

  it("rejects stale owners and cross-workspace/generation operations without any writes", async () => {
    const id = await readySession();
    const plan = planFor(id);
    for (const override of [{ leaseOwner: "wrong" }, { workspaceId: WS_B }, { generation: 1 }]) {
      await expect(
        adapter.commitManagedCollapse({
          workspaceId: WS_A,
          sessionId: id,
          generation: 0,
          operationId: plan.operationId,
          leaseOwner: "worker",
          plan,
          ...override,
        })
      ).rejects.toThrow();
    }
    expect(await counts()).toEqual(Object.fromEntries(outputTables.map((name) => [name, 0])));
  });
  it("does not lower topic sensitivity or retain rejected candidate plaintext", async () => {
    const id = await readySession();
    const previous = await adapter.createFact({
      workspaceId: WS_A,
      scope: "global",
      statement: "Existing confidential",
      subject: "project",
      kind: "other",
      topicKey: "topic-0",
      sensitivity: "internal",
    });
    await raw`UPDATE mnemosyne.mnemo_fact SET sensitivity='confidential' WHERE id=${previous.id}`;
    const plan = planFor(id);
    if (plan.candidates[0]!.kind !== "fact") throw new Error("fixture");
    plan.candidates[0]!.input.statement = "REJECTED_SECRET_CANDIDATE_MARKER";
    const result = await commit(id, plan);
    expect(result.rejectedCount).toBe(1);
    expect(result.factIds).toHaveLength(2);
    const [old] =
      await raw`SELECT status,sensitivity,valid_to FROM mnemosyne.mnemo_fact WHERE id=${previous.id}`;
    expect(old).toMatchObject({ status: "active", sensitivity: "confidential", valid_to: null });
    for (const table of outputTables) {
      const rows = await raw.unsafe(
        `SELECT row_to_json(t) AS value FROM mnemosyne.${table} t WHERE workspace_id=$1`,
        [WS_A]
      );
      expect(JSON.stringify(rows)).not.toContain("REJECTED_SECRET_CANDIDATE_MARKER");
    }
    const provenance =
      await raw`SELECT candidate_hash,rejection_reason FROM mnemosyne.mnemo_extraction_provenance WHERE rejection_reason='sensitivity_ceiling'`;
    expect(provenance).toHaveLength(1);
    expect(provenance[0]!.candidate_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(provenance[0]!.rejection_reason).toBe("sensitivity_ceiling");
  });

  it("revalidates candidate support and binds all writes to immutable session provenance", async () => {
    const id = await readySession();
    const plan = planFor(id);
    plan.candidates[1]!.sourceMessageIds = ["unknown-source"];
    await expect(commit(id, plan)).rejects.toThrow();
    expect(await counts()).toEqual(Object.fromEntries(outputTables.map((name) => [name, 0])));
    plan.candidates[1]!.sourceMessageIds = plan.sourceMessageIds;
    plan.provenance.actorId = "forged";
    for (const candidate of plan.candidates) {
      candidate.input.actorId = "forged";
      candidate.input.workspaceId = WS_B;
    }
    // A forged plan may be rejected or have its claimed provenance ignored, but cannot write it.
    try {
      await commit(id, plan);
    } catch {}
    for (const table of ["mnemo_fact", "mnemo_decision", "mnemo_strategy", "mnemo_episode"]) {
      const rows = await raw.unsafe(`SELECT workspace_id,actor_id FROM mnemosyne.${table}`);
      for (const row of rows)
        expect(row).toMatchObject({ workspace_id: WS_A, actor_id: "key:test" });
    }
  });

  it("creates bitemporal successors for facts and decisions and rolls back topic closures on failure", async () => {
    const id = await readySession();
    const fact = await adapter.createFact({
      workspaceId: WS_A,
      scope: "global",
      statement: "Old fact",
      subject: "project",
      kind: "other",
      topicKey: "topic-0",
      actorId: "old-actor",
    });
    const decision = await adapter.createDecision({
      workspaceId: WS_A,
      kind: "architecture",
      title: "Old decision",
      body: "Old body",
      topicKey: "decision-topic",
      actorId: "old-actor",
    });
    const initial = await counts();
    await raw.unsafe(
      `CREATE OR REPLACE FUNCTION public.fail_managed_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'managed failpoint'; END $$`
    );
    await raw.unsafe(
      `CREATE TRIGGER fail_managed_write BEFORE INSERT ON mnemosyne.mnemo_managed_collapse_effect FOR EACH ROW EXECUTE FUNCTION public.fail_managed_write()`
    );
    try {
      await expect(commit(id)).rejects.toThrow();
      expect(await counts()).toEqual(initial);
      const [f] = await raw`SELECT status,valid_to FROM mnemosyne.mnemo_fact WHERE id=${fact.id}`;
      const [d] =
        await raw`SELECT status,valid_to,body FROM mnemosyne.mnemo_decision WHERE id=${decision.id}`;
      expect(f).toMatchObject({ status: "active", valid_to: null });
      expect(d).toMatchObject({ status: "active", valid_to: null, body: "Old body" });
    } finally {
      await raw.unsafe(
        `DROP TRIGGER fail_managed_write ON mnemosyne.mnemo_managed_collapse_effect`
      );
    }
    const result = await commit(id);
    const [oldFact] =
      await raw`SELECT status,valid_to FROM mnemosyne.mnemo_fact WHERE id=${fact.id}`;
    const [oldDecision] =
      await raw`SELECT status,valid_to,body,superseded_by_id FROM mnemosyne.mnemo_decision WHERE id=${decision.id}`;
    expect(oldFact!.status).toBe("forgotten");
    expect(oldFact!.valid_to).not.toBeNull();
    expect(oldDecision).toMatchObject({
      status: "superseded",
      body: "Old body",
      superseded_by_id: result.decisionIds[0],
    });
    expect(oldDecision!.valid_to).not.toBeNull();
    const [successor] =
      await raw`SELECT session_id,source_message_ids,actor_id FROM mnemosyne.mnemo_fact WHERE topic_key='topic-0' AND status='active'`;
    expect(successor).toMatchObject({
      session_id: id,
      source_message_ids: ["m-user", "m-assistant"],
      actor_id: "key:test",
    });
  });

  it.each(["before", "after"])(
    "links correction episodes when predecessor commits %s successor",
    async (order) => {
      const predecessor = await readySession();
      const successor = await readySession();
      await raw`UPDATE mnemosyne.mnemo_session SET predecessor_session_id=${predecessor} WHERE id=${successor}`;
      const prep = (id: string) => {
        const plan = planFor(id);
        plan.candidates = [];
        plan.relations = [];
        plan.hyperedges = [];
        plan.worthUpdates = [];
        return plan;
      };
      const predecessorPlan = prep(predecessor),
        successorPlan = prep(successor);
      successorPlan.predecessorSessionId = predecessor;
      let a, b;
      if (order === "before") {
        a = await commit(predecessor, predecessorPlan);
        b = await commit(successor, successorPlan);
      } else {
        b = await commit(successor, successorPlan);
        a = await commit(predecessor, predecessorPlan);
      }
      const relations =
        await raw`SELECT source_id,target_id FROM mnemosyne.mnemo_relation WHERE relation='derived_from' AND workspace_id=${WS_A}`;
      expect(relations).toEqual([{ source_id: b.episodeId, target_id: a.episodeId }]);
    }
  );

  it("retains mixed-source knowledge and queues review for a late retraction", async () => {
    const predecessor = await readySession();
    const original = await commit(predecessor);
    const successor = await readySession();
    await raw`UPDATE mnemosyne.mnemo_session SET predecessor_session_id=${predecessor} WHERE id=${successor}`;
    const [event] = await raw`INSERT INTO mnemosyne.mnemo_harness_ingestion_event
      (workspace_id,event_id,source_host,source_client_instance_id,source_session_id,source_generation,enqueue_sequence,event_type,payload_hash,session_id,ledger_state,normalization_version,occurred_at,origin_actor_id,origin_actor_type,origin_sensitivity_ceiling)
      VALUES (${WS_A},'retraction-event','opencode','client-1','host-correction',0,1,'turn.retract',${"a".repeat(64)},${successor},'accepted',1,clock_timestamp(),'key:test','agent','internal') RETURNING id`;
    await raw`INSERT INTO mnemosyne.mnemo_harness_retraction(workspace_id,session_id,ingestion_event_id,source_message_id,predecessor_session_id,reason)
      VALUES(${WS_A},${successor},${event!.id},'m-user',${predecessor},'branch_removed')`;
    const plan = planFor(successor);
    plan.predecessorSessionId = predecessor;
    plan.candidates = [];
    plan.relations = [];
    plan.hyperedges = [];
    plan.worthUpdates = [];
    await commit(successor, plan);
    const facts =
      await raw`SELECT id,status,valid_to FROM mnemosyne.mnemo_fact WHERE workspace_id=${WS_A}`;
    expect(facts).toHaveLength(3);
    for (const fact of facts) expect(fact).toMatchObject({ status: "active", valid_to: null });
    const reviews =
      await raw`SELECT primitive_id,reason,detail FROM mnemosyne.mnemo_review_item WHERE workspace_id=${WS_A}`;
    for (const id of original.factIds)
      expect(reviews).toContainEqual(
        expect.objectContaining({
          primitive_id: id,
          reason: "managed_source_retracted",
          detail: expect.objectContaining({ mixedSource: true }),
        })
      );
  });

  it("rolls back if its lease expires while persisting an output", async () => {
    const id = await readySession();
    await raw`UPDATE mnemosyne.mnemo_session SET collapse_lease_expires_at=clock_timestamp()+interval '500 milliseconds' WHERE id=${id}`;
    await raw.unsafe(
      `CREATE OR REPLACE FUNCTION public.delay_managed_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.7); RETURN NEW; END $$`
    );
    await raw.unsafe(
      `CREATE TRIGGER delay_managed_write BEFORE INSERT ON mnemosyne.mnemo_episode FOR EACH ROW EXECUTE FUNCTION public.delay_managed_write()`
    );
    try {
      await expect(commit(id)).rejects.toThrow();
      expect(await counts()).toEqual(Object.fromEntries(outputTables.map((name) => [name, 0])));
      expect((await sessionRow(id)).status).toBe("collapse_pending");
    } finally {
      await raw.unsafe(`DROP TRIGGER delay_managed_write ON mnemosyne.mnemo_episode`);
    }
  });
  it.each(["topic-0", " TOPIC-0 "])(
    "P153 FM-TOPIC-01: keeps distinct facts sharing %j active",
    async (topicKey) => {
      const id = await readySession();
      const plan = planFor(id);
      if (plan.candidates[1]!.kind !== "fact") throw new Error("fixture");
      plan.candidates[1]!.topicKey = topicKey;
      plan.candidates[1]!.input.topicKey = topicKey;
      await expect(commit(id, plan)).resolves.toMatchObject({ status: "collapsed" });
      const active = await raw`SELECT statement,topic_key,revision_count FROM mnemosyne.mnemo_fact
        WHERE workspace_id=${WS_A} AND session_id=${id} AND status='active' AND valid_to IS NULL
        ORDER BY statement`;
      expect(active).toEqual([
        { statement: "Fact 0", topic_key: null, revision_count: 1 },
        { statement: "Fact 1", topic_key: null, revision_count: 1 },
        { statement: "Fact 2", topic_key: "topic-2", revision_count: 1 },
      ]);
    }
  );
  it("P153 FM-TOPIC-03: ambiguous extracted topics leave an existing fact active", async () => {
    const id = await readySession();
    const prior = await adapter.createFact({
      workspaceId: WS_A,
      scope: "global",
      statement: "Existing database knowledge",
      subject: "project",
      kind: "other",
      topicKey: "topic-0",
    });
    const plan = planFor(id);
    if (plan.candidates[1]!.kind !== "fact") throw new Error("fixture");
    plan.candidates[1]!.topicKey = "topic-0";
    plan.candidates[1]!.input.topicKey = "topic-0";
    await expect(commit(id, plan)).resolves.toMatchObject({ status: "collapsed" });
    const [existing] = await raw`SELECT status,valid_to,topic_key FROM mnemosyne.mnemo_fact
      WHERE workspace_id=${WS_A} AND id=${prior.id}`;
    expect(existing).toMatchObject({ status: "active", valid_to: null, topic_key: "topic-0" });
    const created = await raw`SELECT id FROM mnemosyne.mnemo_fact
      WHERE workspace_id=${WS_A} AND session_id=${id} AND status='active' AND valid_to IS NULL`;
    expect(created).toHaveLength(3);
  });
  it("preserves predecessor scope boundaries when replacing a topic", async () => {
    const id = await readySession();
    await adapter.createFact({
      workspaceId: WS_A,
      scope: "conversation",
      scopeRef: "private-conversation",
      scopeOwner: "user:private-owner",
      statement: "Private old",
      subject: "project",
      kind: "other",
      topicKey: "topic-0",
    });
    await commit(id);
    const [fact] =
      await raw`SELECT scope,scope_ref,scope_owner FROM mnemosyne.mnemo_fact WHERE workspace_id=${WS_A} AND topic_key='topic-0' AND status='active'`;
    expect(fact).toMatchObject({
      scope: "conversation",
      scope_ref: "private-conversation",
      scope_owner: "user:private-owner",
    });
  });
  it("scrubs episode and summary when commit discovers a stricter topic than preparation", async () => {
    const id = await readySession();
    const old = await adapter.createFact({
      workspaceId: WS_A,
      scope: "global",
      statement: "Old",
      subject: "project",
      kind: "other",
      topicKey: "topic-0",
    });
    await raw`UPDATE mnemosyne.mnemo_fact SET sensitivity='restricted' WHERE id=${old.id}`;
    const plan = planFor(id);
    plan.episode.input.narrative = "REFLECTED_SECRET_CANDIDATE";
    plan.episode.input.title = "REFLECTED_SECRET_CANDIDATE";
    plan.summary.goal = "REFLECTED_SECRET_CANDIDATE";
    plan.summary.discoveries = ["REFLECTED_SECRET_CANDIDATE"];
    const result = await commit(id, plan);
    expect(result.rejectedCount).toBe(1);
    const [episode] =
      await raw`SELECT row_to_json(e) AS value FROM mnemosyne.mnemo_episode e WHERE id=${result.episodeId}`;
    expect(JSON.stringify(episode)).not.toContain("REFLECTED_SECRET_CANDIDATE");
    expect(JSON.stringify(await sessionRow(id))).not.toContain("REFLECTED_SECRET_CANDIDATE");
  });

  it("does not replace a topic whose predecessor is awaiting consolidation", async () => {
    const id = await readySession();
    const fact = await adapter.createFact({
      workspaceId: WS_A,
      scope: "global",
      statement: "Pending fact",
      subject: "project",
      kind: "other",
      topicKey: "topic-0",
    });
    await raw`UPDATE mnemosyne.mnemo_fact SET metadata=jsonb_build_object('__mnemoConsolidationPending',true) WHERE id=${fact.id}`;
    const initial = await counts();
    await expect(commit(id)).rejects.toThrow();
    expect(await counts()).toEqual(initial);
    const [previous] =
      await raw`SELECT status,valid_to FROM mnemosyne.mnemo_fact WHERE id=${fact.id}`;
    expect(previous).toMatchObject({ status: "active", valid_to: null });
  });
  it("keeps an existing fact episode association when linking current session facts", async () => {
    const id = await readySession();
    const previousEpisode = await adapter.createEpisode({
      workspaceId: WS_A,
      title: "Prior",
      narrative: "Prior narrative",
      occurredAt: new Date(), // determinism-ok: ingestion timestamp is the caller's wall clock; the assertion never depends on its value
    });
    const fact = await adapter.createFact({
      workspaceId: WS_A,
      scope: "global",
      statement: "Already linked",
      subject: "project",
      kind: "other",
      sessionId: id,
      episodeId: previousEpisode.id,
    });
    await commit(id);
    const [row] = await raw`SELECT episode_id FROM mnemosyne.mnemo_fact WHERE id=${fact.id}`;
    expect(row!.episode_id).toBe(previousEpisode.id);
  });
  it("rechecks the ceiling if a topic appears after preflight classification", async () => {
    const id = await readySession();
    await raw.unsafe(`CREATE OR REPLACE FUNCTION public.concurrent_topic() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN INSERT INTO mnemosyne.mnemo_fact(id,workspace_id,scope,statement,subject,kind,topic_key,sensitivity)
      VALUES ('concurrent-topic',NEW.workspace_id,'global','Confidential prior','project','other','topic-0','confidential'); RETURN NEW; END $$`);
    await raw.unsafe(
      `CREATE TRIGGER concurrent_topic BEFORE INSERT ON mnemosyne.mnemo_episode FOR EACH ROW EXECUTE FUNCTION public.concurrent_topic()`
    );
    try {
      await expect(commit(id)).rejects.toThrow();
      expect(await counts()).toEqual(Object.fromEntries(outputTables.map((name) => [name, 0])));
    } finally {
      await raw.unsafe(`DROP TRIGGER concurrent_topic ON mnemosyne.mnemo_episode`);
    }
  });
});
