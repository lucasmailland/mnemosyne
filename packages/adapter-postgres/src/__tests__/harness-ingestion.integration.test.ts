import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import postgres from "postgres";
import {
  runHarnessIngestionContractTests,
  type HarnessContractSnapshot,
} from "../../../types/src/testing/HarnessIngestionContract.js";
import {
  canonicalJson,
  computeTerminalDigestV1,
  sha256Hex,
  type HarnessEvent,
} from "../../../types/src/index.js";
import { createDrizzleClient, DrizzleStorageAdapter } from "../DrizzleStorageAdapter.js";
import { migrate } from "../migrate.js";

const PG_IMAGE = "pgvector/pgvector:pg17";
const PG_USER = "mnemo_test";
const PG_PASSWORD = "mnemo_test";
const PG_DB = "mnemo_test";
const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

let container: StartedTestContainer;
let databaseUrl: string;
let raw: postgres.Sql;
let adapter: DrizzleStorageAdapter;
let workspaceSequence = 0;

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
  await raw`
    INSERT INTO mnemosyne.mnemo_tenant (id, name)
    VALUES (${TENANT}, 'Harness contract tenant')
    ON CONFLICT (id) DO NOTHING
  `;
}, 120_000);

afterAll(async () => {
  await adapter?.close();
  await raw?.end();
  await container?.stop();
});

async function createWorkspace(): Promise<string> {
  workspaceSequence += 1;
  const suffix = workspaceSequence.toString(16).padStart(12, "0");
  const workspaceId = `11111111-1111-4111-8111-${suffix}`;
  await raw`
    INSERT INTO mnemosyne.mnemo_workspace (id, name, tenant_id)
    VALUES (${workspaceId}, ${`Harness workspace ${workspaceSequence}`}, ${TENANT})
  `;
  return workspaceId;
}

async function inspect(workspaceId: string): Promise<HarnessContractSnapshot> {
  const [sessions, turns, ledger, losses, retractions] = await Promise.all([
    raw<Array<Record<string, unknown>>>`
      SELECT id, source_client_instance_id, source_generation, status, turn_count, token_count,
             last_activity_at, close_kind, close_grace_deadline, sensitivity, capture_incomplete,
             predecessor_session_id, terminal_message_set_digest,
             terminal_max_enqueue_sequence, collapse_lease_owner
      FROM mnemosyne.mnemo_session WHERE workspace_id = ${workspaceId}
      ORDER BY source_generation, id
    `,
    raw<Array<Record<string, unknown>>>`
      SELECT session_id, turn_index, source_message_id, supersedes_source_message_id,
             role, content, content_hash,
             retracted_at IS NOT NULL AS retracted
      FROM mnemosyne.mnemo_session_turn WHERE workspace_id = ${workspaceId}::uuid
      ORDER BY session_id, turn_index
    `,
    raw<Array<Record<string, unknown>>>`
      SELECT event_id, ledger_state, payload_hash, acknowledgement,
             origin_actor_id, origin_actor_type, origin_user_id,
             origin_sensitivity_ceiling
      FROM mnemosyne.mnemo_harness_ingestion_event WHERE workspace_id = ${workspaceId}
      ORDER BY received_at, event_id
    `,
    raw<Array<Record<string, unknown>>>`
      SELECT session_id, lost_source_message_id, lost_role, lost_content_hash
      FROM mnemosyne.mnemo_harness_loss WHERE workspace_id = ${workspaceId}
      ORDER BY created_at, id
    `,
    raw<Array<Record<string, unknown>>>`
      SELECT session_id, source_message_id, predecessor_session_id
      FROM mnemosyne.mnemo_harness_retraction WHERE workspace_id = ${workspaceId}
      ORDER BY created_at, id
    `,
  ]);
  return {
    sessions: sessions.map((row) => ({
      id: String(row.id),
      clientInstanceId: String(row.source_client_instance_id),
      generation: Number(row.source_generation),
      status: String(row.status),
      closeKind: (row.close_kind as string | null) ?? null,
      turnCount: Number(row.turn_count),
      tokenCount: Number(row.token_count),
      lastActivityAt: row.last_activity_at as Date | null,
      closeGraceDeadline: row.close_grace_deadline as Date | null,
      sensitivity: String(row.sensitivity),
      captureIncomplete: Boolean(row.capture_incomplete),
      predecessorSessionId: (row.predecessor_session_id as string | null) ?? null,
      terminalMessageSetDigest: (row.terminal_message_set_digest as string | null) ?? null,
      terminalMaxEnqueueSequence:
        row.terminal_max_enqueue_sequence === null
          ? null
          : Number(row.terminal_max_enqueue_sequence),
      leased: row.collapse_lease_owner !== null,
    })),
    turns: turns.map((row) => ({
      sessionId: String(row.session_id),
      turnIndex: Number(row.turn_index),
      sourceMessageId: String(row.source_message_id),
      supersedesSourceMessageId: (row.supersedes_source_message_id as string | null) ?? null,
      role: String(row.role),
      content: String(row.content),
      contentHash: String(row.content_hash),
      retracted: Boolean(row.retracted),
    })),
    ledger: ledger.map((row) => ({
      eventId: String(row.event_id),
      state: String(row.ledger_state),
      payloadHash: String(row.payload_hash),
      actorId: String(row.origin_actor_id),
      actorType: String(row.origin_actor_type),
      userId: (row.origin_user_id as string | null) ?? null,
      sensitivityCeiling: String(row.origin_sensitivity_ceiling),
      acknowledgement:
        row.acknowledgement as HarnessContractSnapshot["ledger"][number]["acknowledgement"],
    })),
    losses: losses.map((row) => ({
      sessionId: String(row.session_id),
      sourceMessageId: String(row.lost_source_message_id),
      role: String(row.lost_role),
      contentHash: String(row.lost_content_hash),
    })),
    retractions: retractions.map((row) => ({
      sessionId: String(row.session_id),
      sourceMessageId: String(row.source_message_id),
      predecessorSessionId: (row.predecessor_session_id as string | null) ?? null,
    })),
  };
}

runHarnessIngestionContractTests(async () => {
  const workspaceId = await createWorkspace();
  return {
    workspaceId,
    port: adapter,
    inspect: () => inspect(workspaceId),
    getSessionStatus: async (id) => (await adapter.getSession(id, workspaceId))?.status ?? null,
    setSessionLifecycle: async ({
      generation,
      status,
      leased,
      closeKind,
      closeGraceDeadline,
      terminalMaxEnqueueSequence,
      terminalMessageSetDigest,
    }) => {
      await raw`
        UPDATE mnemosyne.mnemo_session
        SET status = ${status},
            collapse_lease_owner = ${leased ? "contract-worker" : null},
            collapse_lease_expires_at = ${leased ? new Date("2099-01-01T00:00:00.000Z") : null},
            close_kind = CASE WHEN ${closeKind === undefined} THEN close_kind ELSE ${closeKind ?? null} END,
            close_grace_deadline = CASE
              WHEN ${closeGraceDeadline === undefined} THEN close_grace_deadline
              ELSE ${closeGraceDeadline ?? null}
            END,
            terminal_max_enqueue_sequence = CASE
              WHEN ${terminalMaxEnqueueSequence === undefined} THEN terminal_max_enqueue_sequence
              ELSE ${terminalMaxEnqueueSequence ?? null}
            END,
            terminal_message_set_digest = CASE
              WHEN ${terminalMessageSetDigest === undefined} THEN terminal_message_set_digest
              ELSE ${terminalMessageSetDigest ?? null}
            END
        WHERE workspace_id = ${workspaceId} AND source_generation = ${generation}
      `;
    },
    seedManagedTurn: async (input) => {
      const [session] = await raw<Array<{ id: string }>>`
        SELECT id FROM mnemosyne.mnemo_session
        WHERE workspace_id = ${workspaceId} AND source_generation = ${input.generation}
      `;
      await raw`
        INSERT INTO mnemosyne.mnemo_session_turn
          (workspace_id, session_id, turn_index, role, content, token_count, created_at,
           source_message_id, content_hash, ingestion_event_workspace_id)
        VALUES
          (${workspaceId}::uuid, ${session!.id},
           (SELECT COALESCE(MAX(turn_index), -1) + 1 FROM mnemosyne.mnemo_session_turn
            WHERE workspace_id = ${workspaceId}::uuid AND session_id = ${session!.id}),
           ${input.role}, ${input.content}, 1, NOW(), ${input.sourceMessageId},
           ${input.contentHash}, ${workspaceId})
      `;
    },
  };
});

it.each(["retention", "forget"])(
  "erases incomplete staged transcript chunks on %s",
  async (mode) => {
    const workspaceId = await createWorkspace();
    const base = {
      host: "claude-code",
      hostSessionId: "erased-chunks",
      clientInstanceId: "client",
      normalizationVersion: 1,
      occurredAt: "2026-09-08T12:00:00.000Z",
    };
    const send = (body: Record<string, unknown>) =>
      adapter.ingestHarnessEvent({
        workspaceId,
        provenance: {
          actorId: "key:erase",
          actorType: "agent",
          userId: null,
          sensitivityCeiling: "internal",
        },
        event: {
          ...base,
          ...body,
          payloadHash: sha256Hex(canonicalJson({ ...base, ...body })),
        } as HarnessEvent,
        receivedAt: new Date("2026-09-08T12:00:00.000Z"),
      });
    const start = await send({ eventId: "start", enqueueSequence: 1, type: "session.start" });
    const part = {
      eventId: "part-0",
      enqueueSequence: 2,
      type: "turn.append",
      sourceGeneration: 0,
      hostMessageId: "private-message",
      role: "assistant",
      content: "private fragment",
      contentHash: sha256Hex("private fragment"),
      chunk: {
        version: 1,
        chunkIndex: 0,
        chunkCount: 2,
        messageContentHash: sha256Hex("private fragment tail"),
      },
    };
    const originalAck = await send(part);
    expect(originalAck.status).toBe("accepted");
    const count = async () =>
      (
        await raw`
    SELECT id FROM mnemosyne.mnemo_harness_message_chunk WHERE workspace_id = ${workspaceId}
  `
      ).length;
    expect(await count()).toBe(1);
    await raw`UPDATE mnemosyne.mnemo_session SET status = 'archived', archived_at = '2026-01-01'
    WHERE workspace_id = ${workspaceId} AND id = ${start.sessionId!}`;
    if (mode === "retention") {
      expect(
        await adapter.purgeManagedTurns({
          workspaceId,
          terminalBefore: new Date("2026-06-01"),
          limit: 1,
        })
      ).toBe(1);
      expect(
        await adapter.purgeManagedTurns({
          workspaceId,
          terminalBefore: new Date("2026-06-01"),
          limit: 1,
        })
      ).toBe(0);
    } else {
      const [episode] = await raw`INSERT INTO mnemosyne.mnemo_episode
      (id, workspace_id, source_conversation_id, title, narrative, occurred_at)
      VALUES ('erased-episode', ${workspaceId}, ${start.sessionId!}, 'erased', 'summary', now()) RETURNING id`;
      expect(
        await adapter.forgetManagedTranscriptForEpisode({
          workspaceId,
          episodeId: episode!.id,
          actorId: "user:eraser",
        })
      ).toMatchObject({ turnsRemoved: 1 });
    }
    expect(await count()).toBe(0);
    // Replays return the durable original ACK, whose status is still "accepted".
    expect(await send(part)).toEqual(originalAck);
    expect(await count()).toBe(0);
    expect(
      await send({
        ...part,
        eventId: "part-1",
        enqueueSequence: 3,
        content: " tail",
        contentHash: sha256Hex(" tail"),
        chunk: { ...part.chunk, chunkIndex: 1 },
      })
    ).toMatchObject({
      status: "rejected",
      retryable: false,
      code: "transcript_erased",
    });
    expect(await count()).toBe(0);
    expect((await inspect(workspaceId)).turns).toHaveLength(0);
  }
);

describe("HarnessRepository PostgreSQL fencing and RLS", () => {
  it("waits on the workspace fence row and loses to a committed quiesce", async () => {
    const workspaceId = await createWorkspace();
    const blocker = postgres(databaseUrl, { max: 1 });
    const held = new Promise<void>((resolve, reject) => {
      void blocker
        .begin(async (tx) => {
          await tx`
            SELECT workspace_id FROM mnemosyne.mnemo_harness_workspace_control
            WHERE workspace_id = ${workspaceId} FOR UPDATE
          `;
          resolve();
          await new Promise((release) => setTimeout(release, 100));
          await tx`
            UPDATE mnemosyne.mnemo_harness_workspace_control
            SET ingestion_enabled = false WHERE workspace_id = ${workspaceId}
          `;
        })
        .catch(reject);
    });
    await held;
    const body = {
      eventId: "fenced-start",
      host: "opencode",
      hostSessionId: "fenced-host",
      clientInstanceId: "fenced-client",
      enqueueSequence: 1,
      occurredAt: "2000-01-01T00:00:00.000Z",
      normalizationVersion: 1 as const,
      type: "session.start" as const,
    };
    const acknowledgement = await adapter.ingestHarnessEvent({
      workspaceId,
      provenance: {
        actorId: "key:fence-test",
        actorType: "agent",
        userId: null,
        sensitivityCeiling: "internal",
      },
      event: { ...body, payloadHash: sha256Hex(canonicalJson(body)) },
      receivedAt: new Date("2026-09-08T12:00:00.000Z"),
    });
    expect(acknowledgement).toMatchObject({
      status: "rejected",
      retryable: true,
      code: "ingestion_disabled",
    });
    expect((await inspect(workspaceId)).sessions).toHaveLength(0);
    await blocker.end();
  });

  it("denies cross-workspace reads under the restricted application role", async () => {
    const workspaceA = await createWorkspace();
    const workspaceB = await createWorkspace();
    const body = {
      eventId: "rls-start",
      host: "opencode",
      hostSessionId: "rls-host",
      clientInstanceId: "rls-client",
      enqueueSequence: 1,
      occurredAt: "2000-01-01T00:00:00.000Z",
      normalizationVersion: 1 as const,
      type: "session.start" as const,
    };
    await adapter.ingestHarnessEvent({
      workspaceId: workspaceB,
      provenance: {
        actorId: "key:rls-test",
        actorType: "agent",
        userId: null,
        sensitivityCeiling: "internal",
      },
      event: { ...body, payloadHash: sha256Hex(canonicalJson(body)) } as HarnessEvent,
      receivedAt: new Date("2026-09-08T12:00:00.000Z"),
    });

    const rows = await raw.begin(async (tx) => {
      await tx`SET LOCAL ROLE app_user`;
      await tx`SELECT set_config('app.workspace_id', ${workspaceA}, true)`;
      await tx`SELECT set_config('mnemosyne.workspace_id', ${workspaceA}, true)`;
      return tx<Array<{ event_id: string }>>`
        SELECT event_id FROM mnemosyne.mnemo_harness_ingestion_event
        WHERE workspace_id = ${workspaceB}
      `;
    });
    expect(rows).toEqual([]);
  });

  it("persists immutable ledger provenance and rejects enqueue provenance mutation", async () => {
    const workspaceId = await createWorkspace();
    const body = {
      eventId: "immutable-ledger-start",
      host: "opencode",
      hostSessionId: "immutable-ledger-host",
      clientInstanceId: "immutable-ledger-client",
      enqueueSequence: 1,
      occurredAt: "2000-01-01T00:00:00.000Z",
      normalizationVersion: 1 as const,
      type: "session.start" as const,
    };
    await adapter.ingestHarnessEvent({
      workspaceId,
      provenance: {
        actorId: "key:immutable-ledger",
        actorType: "agent",
        userId: "user-1",
        sensitivityCeiling: "internal",
      },
      event: { ...body, payloadHash: sha256Hex(canonicalJson(body)) },
      receivedAt: new Date("2026-09-08T12:00:00.000Z"),
    });

    const [ledger] = await raw<
      Array<{
        origin_actor_id: string;
        origin_actor_type: string;
        origin_user_id: string | null;
        origin_sensitivity_ceiling: string;
      }>
    >`
      SELECT origin_actor_id, origin_actor_type, origin_user_id,
             origin_sensitivity_ceiling
      FROM mnemosyne.mnemo_harness_ingestion_event
      WHERE workspace_id = ${workspaceId} AND event_id = ${body.eventId}
    `;
    expect(ledger).toEqual({
      origin_actor_id: "key:immutable-ledger",
      origin_actor_type: "agent",
      origin_user_id: "user-1",
      origin_sensitivity_ceiling: "internal",
    });
    await expect(
      raw`
        UPDATE mnemosyne.mnemo_harness_ingestion_event
        SET enqueue_sequence = 2
        WHERE workspace_id = ${workspaceId} AND event_id = ${body.eventId}
      `
    ).rejects.toThrow(/immutable/i);
    await expect(
      raw`
        UPDATE mnemosyne.mnemo_harness_ingestion_event
        SET origin_actor_id = 'key:other'
        WHERE workspace_id = ${workspaceId} AND event_id = ${body.eventId}
      `
    ).rejects.toThrow(/immutable/i);
    await expect(
      raw`
        UPDATE mnemosyne.mnemo_harness_ingestion_event
        SET ledger_state = 'retryable', acknowledgement = NULL, finalized_at = NULL
        WHERE workspace_id = ${workspaceId} AND event_id = ${body.eventId}
      `
    ).rejects.toThrow(/immutable/i);
  });

  it("protects immutable managed turn source identity", async () => {
    const workspaceId = await createWorkspace();
    const startBody = {
      eventId: "immutable-turn-start",
      host: "opencode" as const,
      hostSessionId: "immutable-turn-host",
      clientInstanceId: "immutable-turn-client",
      enqueueSequence: 1,
      occurredAt: "2000-01-01T00:00:00.000Z",
      normalizationVersion: 1 as const,
      type: "session.start" as const,
    };
    const provenance = {
      actorId: "key:immutable-turn" as const,
      actorType: "agent" as const,
      userId: null,
      sensitivityCeiling: "internal" as const,
    };
    await adapter.ingestHarnessEvent({
      workspaceId,
      provenance,
      event: { ...startBody, payloadHash: sha256Hex(canonicalJson(startBody)) },
      receivedAt: new Date("2026-09-08T12:00:00.000Z"),
    });
    const appendBody = {
      ...startBody,
      eventId: "immutable-turn-append",
      enqueueSequence: 2,
      type: "turn.append" as const,
      sourceGeneration: 0,
      hostMessageId: "immutable-message",
      role: "user" as const,
      content: "immutable",
      contentHash: sha256Hex("immutable"),
    };
    await adapter.ingestHarnessEvent({
      workspaceId,
      provenance,
      event: { ...appendBody, payloadHash: sha256Hex(canonicalJson(appendBody)) },
      receivedAt: new Date("2026-09-08T12:00:01.000Z"),
    });

    await expect(
      raw`
        UPDATE mnemosyne.mnemo_session_turn SET role = 'assistant'
        WHERE workspace_id = ${workspaceId}::uuid AND source_message_id = 'immutable-message'
      `
    ).rejects.toThrow(/immutable/i);
    await expect(
      raw`
        UPDATE mnemosyne.mnemo_session_turn SET content_hash = ${sha256Hex("changed")}
        WHERE workspace_id = ${workspaceId}::uuid AND source_message_id = 'immutable-message'
      `
    ).rejects.toThrow(/immutable/i);
    await expect(
      raw`
        UPDATE mnemosyne.mnemo_session_turn SET source_message_id = 'changed-message'
        WHERE workspace_id = ${workspaceId}::uuid AND source_message_id = 'immutable-message'
      `
    ).rejects.toThrow(/immutable/i);
  });

  it("protects immutable managed session identity while allowing lifecycle updates", async () => {
    const workspaceId = await createWorkspace();
    const body = {
      eventId: "immutable-session-start",
      host: "opencode",
      hostSessionId: "immutable-session-host",
      clientInstanceId: "immutable-session-client",
      enqueueSequence: 1,
      occurredAt: "2000-01-01T00:00:00.000Z",
      normalizationVersion: 1 as const,
      type: "session.start" as const,
    };
    const acknowledgement = await adapter.ingestHarnessEvent({
      workspaceId,
      provenance: {
        actorId: "key:immutable-session",
        actorType: "agent",
        userId: null,
        sensitivityCeiling: "internal",
      },
      event: { ...body, payloadHash: sha256Hex(canonicalJson(body)) },
      receivedAt: new Date("2026-09-08T12:00:00.000Z"),
    });

    await expect(
      raw`
        UPDATE mnemosyne.mnemo_session SET source_session_id = 'mutated'
        WHERE workspace_id = ${workspaceId} AND id = ${acknowledgement.sessionId!}
      `
    ).rejects.toThrow(/immutable/i);
    await expect(
      raw`
        UPDATE mnemosyne.mnemo_session SET sensitivity = 'public'
        WHERE workspace_id = ${workspaceId} AND id = ${acknowledgement.sessionId!}
      `
    ).rejects.toThrow(/immutable/i);
    await expect(
      raw`
        UPDATE mnemosyne.mnemo_session SET status = 'archived'
        WHERE workspace_id = ${workspaceId} AND id = ${acknowledgement.sessionId!}
      `
    ).resolves.toBeDefined();
  });

  it("rejects successor allocation after the maximum generation without a database error", async () => {
    const workspaceId = await createWorkspace();
    await raw`
      INSERT INTO mnemosyne.mnemo_session
        (id, workspace_id, status, source_host, source_session_id,
         source_client_instance_id, source_generation, last_activity_at, sensitivity,
         origin_actor_id, origin_actor_type, origin_sensitivity_ceiling)
      VALUES
        ('max-generation-session', ${workspaceId}, 'collapsed', 'opencode',
         'max-generation-host', 'max-generation-client', 2147483647, NOW(), 'internal',
         'key:max-generation', 'agent', 'internal')
    `;
    const body = {
      eventId: "max-generation-append",
      host: "opencode" as const,
      hostSessionId: "max-generation-host",
      clientInstanceId: "max-generation-client",
      enqueueSequence: 1,
      occurredAt: "2000-01-01T00:00:00.000Z",
      normalizationVersion: 1 as const,
      type: "turn.append" as const,
      sourceGeneration: 2147483647,
      hostMessageId: "max-generation-message",
      role: "user" as const,
      content: "cannot continue",
      contentHash: sha256Hex("cannot continue"),
    };

    await expect(
      adapter.ingestHarnessEvent({
        workspaceId,
        provenance: {
          actorId: "key:max-generation",
          actorType: "agent",
          userId: null,
          sensitivityCeiling: "internal",
        },
        event: { ...body, payloadHash: sha256Hex(canonicalJson(body)) },
        receivedAt: new Date("2026-09-08T12:00:00.000Z"),
      })
    ).resolves.toMatchObject({
      status: "rejected",
      retryable: false,
      code: "generation_exhausted",
    });
  });

  it("reassembles chunked >64 KiB UTF-8 turns atomically and blocks session.end while a chunk is missing", async () => {
    const workspaceId = await createWorkspace();
    const provenance = {
      actorId: "key:chunk-test" as const,
      actorType: "agent" as const,
      userId: null,
      sensitivityCeiling: "internal" as const,
    };
    const startBody = {
      eventId: "chunk-start",
      host: "claude-code" as const,
      hostSessionId: "chunk-host-session",
      clientInstanceId: "chunk-client",
      enqueueSequence: 1,
      occurredAt: "2026-09-08T12:00:00.000Z",
      normalizationVersion: 1 as const,
      type: "session.start" as const,
    };
    await adapter.ingestHarnessEvent({
      workspaceId,
      provenance,
      event: { ...startBody, payloadHash: sha256Hex(canonicalJson(startBody)) },
      receivedAt: new Date("2026-09-08T12:00:00.000Z"),
    });

    const chunk0Text = "🚀".repeat(12_000); // 48,000 UTF-8 bytes
    const chunk1Text = "🌌".repeat(10_000); // 40,000 UTF-8 bytes
    const fullText = `${chunk0Text}${chunk1Text}`; // 88,000 UTF-8 bytes (>64 KiB)
    const fullHash = sha256Hex(fullText);

    const chunk0Body = {
      eventId: "chunk-0",
      host: "claude-code" as const,
      hostSessionId: "chunk-host-session",
      clientInstanceId: "chunk-client",
      enqueueSequence: 2,
      occurredAt: "2026-09-08T12:00:01.000Z",
      normalizationVersion: 1 as const,
      type: "turn.append" as const,
      sourceGeneration: 0,
      hostMessageId: "large-assistant-msg",
      role: "assistant" as const,
      content: chunk0Text,
      contentHash: sha256Hex(chunk0Text),
      chunk: {
        version: 1 as const,
        chunkIndex: 0,
        chunkCount: 2,
        messageContentHash: fullHash,
      },
    };

    const ack0 = await adapter.ingestHarnessEvent({
      workspaceId,
      provenance,
      event: { ...chunk0Body, payloadHash: sha256Hex(canonicalJson(chunk0Body)) },
      receivedAt: new Date("2026-09-08T12:00:01.000Z"),
    });
    expect(ack0).toMatchObject({ status: "accepted", retryable: false, effectiveGeneration: 0 });

    // Before chunk 1 arrives, no turn is materialized and session.end is blocked
    expect((await inspect(workspaceId)).turns).toHaveLength(0);

    const prematureEndBody = {
      eventId: "premature-end",
      host: "claude-code" as const,
      hostSessionId: "chunk-host-session",
      clientInstanceId: "chunk-client",
      enqueueSequence: 3,
      occurredAt: "2026-09-08T12:00:02.000Z",
      normalizationVersion: 1 as const,
      type: "session.end" as const,
      sourceGeneration: 0,
      reason: "host_end" as const,
      finalMessageSetDigest: computeTerminalDigestV1([]),
      maxEnqueueSequence: 2,
    };
    const prematureAck = await adapter.ingestHarnessEvent({
      workspaceId,
      provenance,
      event: { ...prematureEndBody, payloadHash: sha256Hex(canonicalJson(prematureEndBody)) },
      receivedAt: new Date("2026-09-08T12:00:02.000Z"),
    });
    expect(prematureAck).toMatchObject({
      status: "rejected",
      retryable: true,
      code: "incomplete_terminal_barrier",
    });

    // Cancel the premature session.end at seq 3 via event.cancel at seq 4, then send chunk 1 at seq 5
    const cancelBody = {
      eventId: "cancel-premature-end",
      host: "claude-code" as const,
      hostSessionId: "chunk-host-session",
      clientInstanceId: "chunk-client",
      enqueueSequence: 4,
      occurredAt: "2026-09-08T12:00:03.000Z",
      normalizationVersion: 1 as const,
      type: "event.cancel" as const,
      sourceGeneration: 0,
      targetEventId: "premature-end",
      reason: "terminal_rebuild" as const,
    };
    await adapter.ingestHarnessEvent({
      workspaceId,
      provenance,
      event: { ...cancelBody, payloadHash: sha256Hex(canonicalJson(cancelBody)) },
      receivedAt: new Date("2026-09-08T12:00:03.000Z"),
    });

    const chunk1Body = {
      eventId: "chunk-1",
      host: "claude-code" as const,
      hostSessionId: "chunk-host-session",
      clientInstanceId: "chunk-client",
      enqueueSequence: 5,
      occurredAt: "2026-09-08T12:00:04.000Z",
      normalizationVersion: 1 as const,
      type: "turn.append" as const,
      sourceGeneration: 0,
      hostMessageId: "large-assistant-msg",
      role: "assistant" as const,
      content: chunk1Text,
      contentHash: sha256Hex(chunk1Text),
      chunk: {
        version: 1 as const,
        chunkIndex: 1,
        chunkCount: 2,
        messageContentHash: fullHash,
      },
    };
    const ack1 = await adapter.ingestHarnessEvent({
      workspaceId,
      provenance,
      event: { ...chunk1Body, payloadHash: sha256Hex(canonicalJson(chunk1Body)) },
      receivedAt: new Date("2026-09-08T12:00:04.000Z"),
    });
    expect(ack1).toMatchObject({ status: "accepted", retryable: false, effectiveGeneration: 0 });

    const snapshot = await inspect(workspaceId);
    expect(snapshot.turns).toHaveLength(1);
    expect(snapshot.turns[0]?.content).toBe(fullText);
    expect(snapshot.turns[0]?.contentHash).toBe(fullHash);

    const endBody = {
      eventId: "chunk-end",
      host: "claude-code" as const,
      hostSessionId: "chunk-host-session",
      clientInstanceId: "chunk-client",
      enqueueSequence: 6,
      occurredAt: "2026-09-08T12:00:05.000Z",
      normalizationVersion: 1 as const,
      type: "session.end" as const,
      sourceGeneration: 0,
      reason: "host_end" as const,
      finalMessageSetDigest: computeTerminalDigestV1([
        {
          type: "M",
          hostMessageId: "large-assistant-msg",
          role: "assistant",
          contentHash: fullHash,
        },
      ]),
      maxEnqueueSequence: 5,
    };
    const endAck = await adapter.ingestHarnessEvent({
      workspaceId,
      provenance,
      event: { ...endBody, payloadHash: sha256Hex(canonicalJson(endBody)) },
      receivedAt: new Date("2026-09-08T12:00:05.000Z"),
    });
    expect(endAck).toMatchObject({ status: "accepted", retryable: false, effectiveGeneration: 0 });
  });
  it("keeps chunk fragments staged before an inactivity claim with the successor that materializes the message", async () => {
    const workspaceId = await createWorkspace();
    const provenance = {
      actorId: "key:chunk-claim" as const,
      actorType: "agent" as const,
      userId: null,
      sensitivityCeiling: "internal" as const,
    };
    const base = {
      host: "claude-code" as const,
      hostSessionId: "chunk-claim-session",
      clientInstanceId: "chunk-claim-client",
      normalizationVersion: 1 as const,
    };
    const send = (body: Record<string, unknown>, at: string) =>
      adapter.ingestHarnessEvent({
        workspaceId,
        provenance,
        event: { ...body, payloadHash: sha256Hex(canonicalJson(body)) } as HarnessEvent,
        receivedAt: new Date(at),
      });
    await send(
      {
        ...base,
        eventId: "claim-start",
        enqueueSequence: 1,
        occurredAt: "2026-09-08T12:00:00.000Z",
        type: "session.start",
      },
      "2026-09-08T12:00:00.000Z"
    );
    const part0 = "a".repeat(40_000);
    const part1 = "b".repeat(40_000);
    const fullHash = sha256Hex(`${part0}${part1}`);
    const fragment = (index: number, content: string, sequence: number) => ({
      ...base,
      eventId: `claim-chunk-${index}`,
      enqueueSequence: sequence,
      occurredAt: "2026-09-08T12:00:01.000Z",
      type: "turn.append",
      sourceGeneration: 0,
      hostMessageId: "claimed-large-msg",
      role: "assistant",
      content,
      contentHash: sha256Hex(content),
      chunk: { version: 1, chunkIndex: index, chunkCount: 2, messageContentHash: fullHash },
    });
    expect(await send(fragment(0, part0, 2), "2026-09-08T12:00:01.000Z")).toMatchObject({
      status: "accepted",
      effectiveGeneration: 0,
    });

    // The inactivity worker claims generation 0 between the two fragments.
    await raw`
      UPDATE mnemosyne.mnemo_session
      SET status = 'collapse_pending', close_kind = 'provisional',
          collapse_lease_owner = 'inactivity-worker',
          collapse_lease_expires_at = ${new Date("2099-01-01T00:00:00.000Z")}
      WHERE workspace_id = ${workspaceId} AND source_generation = 0
    `;

    expect(await send(fragment(1, part1, 3), "2026-09-08T12:00:02.000Z")).toMatchObject({
      status: "accepted",
      effectiveGeneration: 1,
    });
    const snapshot = await inspect(workspaceId);
    const successor = snapshot.sessions.find((s) => s.generation === 1);
    expect(snapshot.turns).toHaveLength(1);
    expect(snapshot.turns[0]).toMatchObject({
      sessionId: successor?.id,
      sourceMessageId: "claimed-large-msg",
      content: `${part0}${part1}`,
      contentHash: fullHash,
    });
    const staged = await raw`
      SELECT id FROM mnemosyne.mnemo_harness_message_chunk WHERE workspace_id = ${workspaceId}
    `;
    expect(staged).toHaveLength(0);
  });
});
