import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import postgres from "postgres";
import { canonicalJson, sha256Hex } from "@mnemo-ai/types";
import { createDrizzleClient, DrizzleStorageAdapter } from "../DrizzleStorageAdapter.js";
import { migrate } from "../migrate.js";

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WS = "55555555-5555-4555-8555-555555555555";

let container: StartedTestContainer;
let raw: postgres.Sql;
let adapter: DrizzleStorageAdapter;

beforeAll(async () => {
  container = await new GenericContainer("pgvector/pgvector:pg17")
    .withEnvironment({
      POSTGRES_USER: "mnemo_test",
      POSTGRES_PASSWORD: "mnemo_test",
      POSTGRES_DB: "mnemo_test",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
    .start();
  const url = `postgres://mnemo_test:mnemo_test@${container.getHost()}:${container.getMappedPort(5432)}/mnemo_test`;
  await migrate({ databaseUrl: url, log: () => undefined });
  raw = postgres(url, { max: 10, onnotice: () => undefined });
  const client = createDrizzleClient(url);
  adapter = new DrizzleStorageAdapter(client.db, client.pgClient);
  await raw`INSERT INTO mnemosyne.mnemo_tenant (id, name) VALUES (${TENANT}, 'Retention')`;
  await raw`INSERT INTO mnemosyne.mnemo_workspace (id, name, tenant_id) VALUES (${WS}, 'A', ${TENANT})`;
}, 120_000);

afterAll(async () => {
  await adapter?.close();
  await raw?.end();
  await container?.stop();
});

beforeEach(async () => {
  await raw`TRUNCATE mnemosyne.mnemo_session, mnemosyne.mnemo_harness_ingestion_event,
    mnemosyne.mnemo_harness_message_tombstone, mnemosyne.mnemo_deletion_log,
    mnemosyne.mnemo_episode CASCADE`;
});

/** A managed session that reached `status` at `terminalAt`, with one visible turn. */
async function managedSession(opts: {
  id: string;
  status: "collapsed" | "archived" | "active" | "collapse_pending";
  terminalAt?: string;
  content?: string;
  sourceMessageId?: string;
  payloadHash?: string;
  contentHash?: string;
}) {
  const {
    id,
    status,
    terminalAt,
    content = "SECRET-TRANSCRIPT",
    sourceMessageId = `m-${id}`,
    payloadHash = `hash-${id}`,
    contentHash = `chash-${id}`,
  } = opts;
  await raw`
    INSERT INTO mnemosyne.mnemo_session
      (id, workspace_id, status, source_host, source_session_id, source_client_instance_id,
       source_generation, sensitivity, origin_actor_id, origin_actor_type, origin_sensitivity_ceiling,
       collapsed_at, archived_at)
    VALUES (${id}, ${WS}, ${status}, 'codex', ${`host-${id}`}, 'client-a', 0, 'internal',
            'key:test', 'agent', 'internal',
            ${status === "collapsed" ? (terminalAt ?? null) : null}::timestamptz,
            ${status === "archived" ? (terminalAt ?? null) : null}::timestamptz)`;
  const [event] = await raw`
    INSERT INTO mnemosyne.mnemo_harness_ingestion_event
      (workspace_id, event_id, source_host, source_client_instance_id, source_session_id,
       source_generation, enqueue_sequence, event_type, payload_hash, normalization_version,
       occurred_at, origin_actor_id, origin_actor_type, origin_sensitivity_ceiling,
       session_id, ledger_state, acknowledgement)
    VALUES (${WS}, ${`event-${id}`}, 'codex', 'client-a', ${`host-${id}`}, 0, 1, 'turn.append',
            ${payloadHash}, 1, now(), 'key:test', 'agent', 'internal', ${id}, 'accepted',
            ${raw.json({ eventId: `event-${id}`, status: "accepted", retryable: false })})
    RETURNING id`;
  await raw`
    INSERT INTO mnemosyne.mnemo_session_turn
      (workspace_id, session_id, turn_index, role, content, source_message_id, content_hash, ingestion_event_id)
    VALUES (${WS}::uuid, ${id}, 0, 'user', ${content}, ${sourceMessageId}, ${contentHash}, ${event!.id})`;
}

/** A pre-harness session: no source_host, so retention must never touch it. */
async function legacySession(id: string) {
  await raw`
    INSERT INTO mnemosyne.mnemo_session (id, workspace_id, status, collapsed_at)
    VALUES (${id}, ${WS}, 'collapsed', now() - interval '400 days')`;
  await raw`
    INSERT INTO mnemosyne.mnemo_session_turn (workspace_id, session_id, turn_index, role, content)
    VALUES (${WS}::uuid, ${id}, 0, 'user', 'legacy content')`;
}

const turnCount = async (sessionId: string) =>
  Number(
    (
      await raw`SELECT count(*)::int AS n FROM mnemosyne.mnemo_session_turn WHERE session_id = ${sessionId}`
    )[0]!.n
  );

const purge = (terminalBefore: string, limit = 100) =>
  adapter.purgeManagedTurns({ workspaceId: WS, terminalBefore: new Date(terminalBefore), limit });

describe("managed transcript retention", () => {
  it("deletes only managed turns whose session went terminal before the cutoff", async () => {
    await managedSession({
      id: "old-collapsed",
      status: "collapsed",
      terminalAt: "2026-01-01T00:00:00Z",
    });
    await managedSession({
      id: "old-archived",
      status: "archived",
      terminalAt: "2026-01-01T00:00:00Z",
    });
    await managedSession({ id: "recent", status: "collapsed", terminalAt: "2026-09-01T00:00:00Z" });
    await managedSession({ id: "still-active", status: "active" });
    await managedSession({ id: "pending", status: "collapse_pending" });
    await legacySession("legacy");

    expect(await purge("2026-06-01T00:00:00Z")).toBe(2);

    expect(await turnCount("old-collapsed")).toBe(0);
    expect(await turnCount("old-archived")).toBe(0);
    // Everything else is either inside the window, not terminal, or not managed.
    for (const id of ["recent", "still-active", "pending", "legacy"]) {
      expect(await turnCount(id)).toBe(1);
    }
  });

  it("treats the cutoff as strictly exclusive", async () => {
    await managedSession({
      id: "exactly-at",
      status: "collapsed",
      terminalAt: "2026-06-01T00:00:00Z",
    });
    expect(await purge("2026-06-01T00:00:00Z")).toBe(0);
    expect(await turnCount("exactly-at")).toBe(1);

    expect(await purge("2026-06-01T00:00:00.001Z")).toBe(1);
    expect(await turnCount("exactly-at")).toBe(0);
  });

  it("leaves a tombstone carrying identity and the original acknowledgement, never content", async () => {
    await managedSession({
      id: "purged",
      status: "collapsed",
      terminalAt: "2026-01-01T00:00:00Z",
      content: "SECRET-TRANSCRIPT",
    });
    await purge("2026-06-01T00:00:00Z");

    const [tombstone] = await raw`
      SELECT * FROM mnemosyne.mnemo_harness_message_tombstone WHERE workspace_id = ${WS}`;
    expect(tombstone).toMatchObject({
      session_id: "purged",
      source_host: "codex",
      source_client_instance_id: "client-a",
      source_session_id: "host-purged",
      source_generation: 0,
      event_id: "event-purged",
      source_message_id: "m-purged",
      content_hash: "chash-purged",
      acknowledgement: { eventId: "event-purged", status: "accepted", retryable: false },
    });
    // The whole point: identity survives, the words do not.
    expect(JSON.stringify(tombstone)).not.toContain("SECRET-TRANSCRIPT");
  });

  it("records a deletion audit entry for every purged turn", async () => {
    await managedSession({
      id: "audited",
      status: "collapsed",
      terminalAt: "2026-01-01T00:00:00Z",
    });
    await purge("2026-06-01T00:00:00Z");

    const audit = await raw`
      SELECT deleted_item_type, deletion_type, actor_id, reason
      FROM mnemosyne.mnemo_deletion_log WHERE workspace_id = ${WS}::uuid`;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      deleted_item_type: "session_turn",
      deletion_type: "hard",
      actor_id: "system:managed-retention",
    });
  });

  it("is idempotent across repeated ticks and bounded by its limit", async () => {
    for (const n of [0, 1, 2]) {
      await managedSession({
        id: `batch-${n}`,
        status: "collapsed",
        terminalAt: "2026-01-01T00:00:00Z",
      });
    }
    expect(await purge("2026-06-01T00:00:00Z", 2)).toBe(2);
    expect(await purge("2026-06-01T00:00:00Z", 2)).toBe(1);
    expect(await purge("2026-06-01T00:00:00Z", 2)).toBe(0);

    const [{ n }] = await raw`
      SELECT count(*)::int AS n FROM mnemosyne.mnemo_harness_message_tombstone WHERE workspace_id = ${WS}`;
    expect(Number(n)).toBe(3);
  });

  it("answers an arbitrarily delayed duplicate from the tombstone, without restoring content", async () => {
    const body = {
      eventId: "event-delayed",
      host: "codex" as const,
      hostSessionId: "host-delayed",
      clientInstanceId: "client-a",
      enqueueSequence: 1,
      occurredAt: "2026-01-01T00:00:00.000Z",
      normalizationVersion: 1 as const,
      type: "turn.append" as const,
      sourceGeneration: 0,
      hostMessageId: "m-delayed",
      role: "user" as const,
      content: "SECRET-TRANSCRIPT",
      contentHash: sha256Hex("SECRET-TRANSCRIPT"),
    };
    const payloadHash = sha256Hex(canonicalJson(body));
    await managedSession({
      id: "delayed",
      status: "collapsed",
      terminalAt: "2026-01-01T00:00:00Z",
      payloadHash,
      contentHash: body.contentHash,
    });
    await purge("2026-06-01T00:00:00Z");

    const ack = await adapter.ingestHarnessEvent({
      workspaceId: WS,
      provenance: {
        actorId: "key:test",
        actorType: "agent",
        userId: null,
        sensitivityCeiling: "internal",
      },
      event: { ...body, payloadHash } as never,
      receivedAt: new Date(), // determinism-ok: ingestion timestamp is the caller's wall clock; the assertion never depends on its value
    });

    expect(ack).toMatchObject({ eventId: "event-delayed", status: "accepted", retryable: false });
    // A replayed message must not resurrect a transcript retention already erased.
    expect(await turnCount("delayed")).toBe(0);
  });
});

describe("workspace enumeration for per-workspace jobs", () => {
  it("includes a workspace that only has managed sessions, with no facts yet", async () => {
    await managedSession({
      id: "sessions-only",
      status: "collapsed",
      terminalAt: "2026-01-01T00:00:00Z",
    });

    // Enumeration used to require an active fact, so a workspace that had captured
    // transcripts but produced no knowledge yet was invisible to every per-workspace
    // job — including the one that is supposed to delete those transcripts.
    expect(await adapter.listWorkspaceIds()).toContain(WS);
  });

  it("lists a workspace once even when it has both facts and managed sessions", async () => {
    await managedSession({ id: "both", status: "collapsed", terminalAt: "2026-01-01T00:00:00Z" });
    await adapter.createFact({
      workspaceId: WS,
      scope: "global",
      statement: "A fact",
      subject: "test",
      kind: "other",
    });

    const ids = await adapter.listWorkspaceIds();
    expect(ids.filter((id) => id === WS)).toHaveLength(1);
  });
});

describe("human feedback trends", () => {
  it("ignores unrated sessions instead of averaging them in as failures", async () => {
    await raw`
      INSERT INTO mnemosyne.mnemo_session (id, workspace_id, status, collapsed_at, outcome_rating)
      VALUES ('rated-good', ${WS}, 'collapsed', now() - interval '1 day', 'success'),
             ('unrated-1', ${WS}, 'collapsed', now() - interval '1 day', NULL),
             ('unrated-2', ${WS}, 'collapsed', now() - interval '1 day', NULL)`;

    const [row] = await raw`
      SELECT session_collapse_qual_cur AS q FROM mnemosyne.mnemo_metacognition_trends(${WS}::uuid)`;

    // One rated success and two unrated: quality is 1, not 1/3. "Unrated" is
    // absent data, not a bad outcome, and managed capture creates many of them.
    expect(Number(row!.q)).toBe(1);
  });

  it("reports zero rather than dividing by nothing when no session is rated", async () => {
    await raw`
      INSERT INTO mnemosyne.mnemo_session (id, workspace_id, status, collapsed_at, outcome_rating)
      VALUES ('unrated-only', ${WS}, 'collapsed', now() - interval '1 day', NULL)`;

    const [row] = await raw`
      SELECT session_collapse_qual_cur AS q FROM mnemosyne.mnemo_metacognition_trends(${WS}::uuid)`;
    expect(Number(row!.q)).toBe(0);
  });
});

describe("managed lifecycle metrics aggregate", () => {
  it("groups managed sessions without ever returning an identifier", async () => {
    await managedSession({ id: "m-active", status: "active" });
    await managedSession({ id: "m-pending", status: "collapse_pending" });
    await managedSession({
      id: "m-collapsed",
      status: "collapsed",
      terminalAt: "2026-09-01T00:00:00Z",
    });
    await raw`
      INSERT INTO mnemosyne.mnemo_session
        (id, workspace_id, status, source_host, source_session_id, source_client_instance_id,
         source_generation, archive_reason, archived_at, collapse_attempts, capture_incomplete)
      VALUES ('m-archived', ${WS}, 'archived', 'codex', 'host-arch', 'client-a', 0,
              'empty_session', now(), 0, true)`;
    await legacySession("legacy-ignored");

    const stats = await adapter.managedLifecycleStats!();

    expect(stats).toMatchObject({
      active: 1,
      pending: 1,
      collapsed: 1,
      incompleteCapture: 1,
      archivedByReason: [{ reason: "empty_session", count: 1 }],
    });
    // A legacy session has no source_host and must not appear in managed gauges.
    expect(stats.active + stats.pending + stats.collapsed).toBe(3);
    // Nothing identifying may reach a Prometheus label.
    expect(JSON.stringify(stats)).not.toContain(WS);
    expect(JSON.stringify(stats)).not.toContain("m-collapsed");
  });

  it("separates a session that gave up from one that never tried", async () => {
    await raw`
      INSERT INTO mnemosyne.mnemo_session
        (id, workspace_id, status, source_host, source_session_id, source_client_instance_id,
         source_generation, archive_reason, archived_at, collapse_attempts)
      VALUES ('gave-up', ${WS}, 'archived', 'codex', 'h1', 'client-a', 0, 'too_few_turns', now(), 7),
             ('never-tried', ${WS}, 'archived', 'codex', 'h2', 'client-a', 0, 'empty_session', now(), 0)`;
    await managedSession({ id: "worked", status: "collapsed", terminalAt: "2026-09-01T00:00:00Z" });

    const { extraction } = await adapter.managedLifecycleStats!();
    const byResult = Object.fromEntries(extraction.map((e) => [e.result, e.count]));
    expect(byResult).toMatchObject({ succeeded: 1, failed: 1, not_attempted: 1 });
  });

  it("reports no pending age at all when nothing is waiting", async () => {
    await managedSession({ id: "done", status: "collapsed", terminalAt: "2026-09-01T00:00:00Z" });
    expect((await adapter.managedLifecycleStats!()).oldestPendingAgeSeconds).toBeNull();
  });
});

/** Link an episode to a managed session the way a managed collapse does. */
async function episodeFor(sessionId: string, episodeId: string) {
  await raw`
    INSERT INTO mnemosyne.mnemo_episode (id, workspace_id, title, narrative, occurred_at, source_conversation_id)
    VALUES (${episodeId}, ${WS}, 'Session', 'Narrative', now(), ${sessionId})`;
}

describe("forgetting an episode also forgets its transcript", () => {
  const EPISODE = "11111111-1111-4111-8111-111111111111";

  it("removes the linked session's transcript and leaves the same audit trail as retention", async () => {
    await managedSession({ id: "linked", status: "collapsed", terminalAt: "2026-09-01T00:00:00Z" });
    await episodeFor("linked", EPISODE);

    const result = await adapter.forgetManagedTranscriptForEpisode!({
      workspaceId: WS,
      episodeId: EPISODE,
      actorId: "user:alice",
    });

    expect(result).toMatchObject({ sessionId: "linked", turnsRemoved: 1 });
    expect(await turnCount("linked")).toBe(0);

    // Forgetting the knowledge must not leave the words behind, and it is audited
    // as the caller — not as the retention system.
    const [tombstone] = await raw`
      SELECT session_id, acknowledgement FROM mnemosyne.mnemo_harness_message_tombstone`;
    expect(tombstone).toMatchObject({ session_id: "linked" });
    const [audit] = await raw`
      SELECT actor_id, deleted_item_type, deletion_type FROM mnemosyne.mnemo_deletion_log`;
    expect(audit).toMatchObject({
      actor_id: "user:alice",
      deleted_item_type: "session_turn",
      deletion_type: "hard",
    });
  });

  it("ignores the retention window: forgetting is immediate", async () => {
    // Terminal seconds ago, far inside any retention window.
    await managedSession({
      id: "fresh",
      status: "collapsed",
      terminalAt: new Date().toISOString(), // determinism-ok: deliberately inside any retention window, so the assertion is that it is NOT purged
    });
    await episodeFor("fresh", EPISODE);

    expect(
      (
        await adapter.forgetManagedTranscriptForEpisode!({
          workspaceId: WS,
          episodeId: EPISODE,
          actorId: "user:alice",
        })
      ).turnsRemoved
    ).toBe(1);
  });

  it("is a no-op for an episode with no managed session behind it", async () => {
    await raw`
      INSERT INTO mnemosyne.mnemo_episode (id, workspace_id, title, narrative, occurred_at)
      VALUES (${EPISODE}, ${WS}, 'Orphan', 'No session', now())`;

    expect(
      await adapter.forgetManagedTranscriptForEpisode!({
        workspaceId: WS,
        episodeId: EPISODE,
        actorId: "user:alice",
      })
    ).toMatchObject({ sessionId: null, turnsRemoved: 0 });
  });

  it("never reaches across workspaces", async () => {
    await managedSession({ id: "mine", status: "collapsed", terminalAt: "2026-09-01T00:00:00Z" });
    await episodeFor("mine", EPISODE);

    const result = await adapter.forgetManagedTranscriptForEpisode!({
      workspaceId: "66666666-6666-4666-8666-666666666666",
      episodeId: EPISODE,
      actorId: "user:alice",
    });

    expect(result).toMatchObject({ sessionId: null, turnsRemoved: 0 });
    expect(await turnCount("mine")).toBe(1);
  });
});

describe("managed data in a workspace export", () => {
  it("exports session metadata without inventing content, and the transcripts separately", async () => {
    await managedSession({
      id: "exported",
      status: "collapsed",
      terminalAt: "2026-09-01T00:00:00Z",
    });

    const sessions = await adapter.exportManagedSessions!({ workspaceId: WS, limit: 100 });
    expect(sessions).toEqual([
      expect.objectContaining({
        sessionId: "exported",
        sourceHost: "codex",
        status: "collapsed",
        turnCount: expect.any(Number),
      }),
    ]);
    // Metadata is metadata: the transcript is a separate, explicitly requested resource.
    expect(JSON.stringify(sessions)).not.toContain("SECRET-TRANSCRIPT");

    const transcripts = await adapter.exportManagedTranscripts!({ workspaceId: WS, limit: 100 });
    expect(transcripts).toEqual([
      expect.objectContaining({
        sessionId: "exported",
        role: "user",
        content: "SECRET-TRANSCRIPT",
        sourceMessageId: "m-exported",
      }),
    ]);
  });

  it("does not export a transcript that retention already erased", async () => {
    await managedSession({ id: "gone", status: "collapsed", terminalAt: "2026-01-01T00:00:00Z" });
    await purge("2026-06-01T00:00:00Z");

    expect(await adapter.exportManagedTranscripts!({ workspaceId: WS, limit: 100 })).toEqual([]);
    // The session itself still exports: its metadata outlives its words.
    expect(await adapter.exportManagedSessions!({ workspaceId: WS, limit: 100 })).toHaveLength(1);
  });

  it("excludes legacy sessions, which this export surface does not describe", async () => {
    await legacySession("legacy-export");
    expect(await adapter.exportManagedSessions!({ workspaceId: WS, limit: 100 })).toEqual([]);
  });
});
