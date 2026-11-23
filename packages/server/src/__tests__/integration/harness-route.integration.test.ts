import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import postgres from "postgres";
import bcrypt from "bcrypt";
import { canonicalJson, sha256Hex, type HarnessEvent } from "@mnemo-ai/types";
import { createDrizzleClient, DrizzleStorageAdapter } from "@mnemo-ai/adapter-postgres";
import { migrate } from "../../../../adapter-postgres/src/migrate.js";

import { createApp } from "../../app.js";
import { BCRYPT_COST, type ApiKeyLookup } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";

const TENANT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKSPACE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER_WORKSPACE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const API_KEY = "mns_live_harnessintegrationkey0001";

let container: StartedTestContainer;
let raw: postgres.Sql;
let storage: DrizzleStorageAdapter;
let app: ReturnType<typeof createApp>;
let apiKeys: ApiKeyLookup;

type EventBody = HarnessEvent extends infer Event
  ? Event extends HarnessEvent
    ? Omit<Event, "payloadHash">
    : never
  : never;

function event<T extends EventBody>(body: T): HarnessEvent {
  return { ...body, payloadHash: sha256Hex(canonicalJson(body)) } as HarnessEvent;
}

function startEvent(): HarnessEvent {
  return event({
    eventId: "route-start-1",
    host: "opencode",
    hostSessionId: "route-host-session",
    clientInstanceId: "route-client",
    enqueueSequence: 1,
    occurredAt: "2026-09-09T00:00:00.000Z",
    normalizationVersion: 1,
    type: "session.start",
    sensitivity: "internal",
  });
}

function appendEvent(): HarnessEvent {
  const content = "captured through the real HTTP route";
  return event({
    eventId: "route-append-1",
    host: "opencode",
    hostSessionId: "route-host-session",
    clientInstanceId: "route-client",
    enqueueSequence: 2,
    occurredAt: "2026-09-09T00:00:01.000Z",
    normalizationVersion: 1,
    type: "turn.append",
    sourceGeneration: 0,
    hostMessageId: "route-message-1",
    role: "user",
    content,
    contentHash: sha256Hex(content),
  });
}

function sourceStart(
  eventId: string,
  hostSessionId: string,
  enqueueSequence = 1,
  sensitivity?: "public" | "internal"
): HarnessEvent {
  return event({
    eventId,
    host: "opencode",
    hostSessionId,
    clientInstanceId: "route-client",
    enqueueSequence,
    occurredAt: "2026-09-09T00:00:00.000Z",
    normalizationVersion: 1,
    type: "session.start",
    ...(sensitivity ? { sensitivity } : {}),
  });
}

function sourceAppend(
  eventId: string,
  hostSessionId: string,
  enqueueSequence: number,
  hostMessageId: string
): HarnessEvent {
  const content = `content:${hostMessageId}`;
  return event({
    eventId,
    host: "opencode",
    hostSessionId,
    clientInstanceId: "route-client",
    enqueueSequence,
    occurredAt: "2026-09-09T00:00:01.000Z",
    normalizationVersion: 1,
    type: "turn.append",
    sourceGeneration: 0,
    hostMessageId,
    role: "user",
    content,
    contentHash: sha256Hex(content),
  });
}

beforeAll(async () => {
  vi.stubEnv("MNEMO_HARNESS_V1_ENABLED", "true");
  container = await new GenericContainer("pgvector/pgvector:pg17")
    .withEnvironment({ POSTGRES_USER: "mnemo", POSTGRES_PASSWORD: "mnemo", POSTGRES_DB: "mnemo" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
    .start();
  const databaseUrl = `postgres://mnemo:mnemo@${container.getHost()}:${container.getMappedPort(5432)}/mnemo`;
  await migrate({ databaseUrl, log: () => undefined });
  raw = postgres(databaseUrl, { max: 4, connection: { search_path: "mnemosyne,public" } });
  await raw`
    INSERT INTO mnemosyne.mnemo_tenant (id, name) VALUES (${TENANT_ID}, 'Harness route tenant')
  `;
  await raw`
    INSERT INTO mnemosyne.mnemo_workspace (id, name, tenant_id)
    VALUES (${WORKSPACE_ID}, 'Harness route workspace', ${TENANT_ID}),
           (${OTHER_WORKSPACE_ID}, 'Other harness route workspace', ${TENANT_ID})
  `;
  const keyHash = await bcrypt.hash(API_KEY, BCRYPT_COST);
  apiKeys = {
    async listActive() {
      return [
        {
          id: "route-key-row",
          keyHash,
          workspaceId: WORKSPACE_ID,
          scopes: ["memory:session"],
          plan: "pro",
          userId: "route-user",
          maxSensitivity: "internal",
        },
      ];
    },
    touch: () => undefined,
  };
  const client = createDrizzleClient(databaseUrl);
  storage = new DrizzleStorageAdapter(client.db, client.pgClient);
  app = createApp({
    deps: {
      apiKeys,
      storage,
      embedModel: "test",
      telemetry: {
        startSpan: () => ({ setAttribute: () => {}, setStatus: () => {}, end: () => {} }),
        counter: () => {},
        histogram: () => {},
        gauge: () => {},
        shutdown: async () => {},
      },
    } as unknown as ServerDeps,
    version: "harness-route-test",
  });
}, 120_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  await storage?.close().catch(() => undefined);
  await raw?.end().catch(() => undefined);
  await container?.stop().catch(() => undefined);
});

function send(
  events: HarnessEvent[],
  options: {
    targetApp?: ReturnType<typeof createApp>;
    expectedWorkspaceId?: string;
  } = {}
) {
  return (options.targetApp ?? app).request("/harness/v1/events", {
    method: "POST",
    headers: {
      authorization: `Bearer ${API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      protocolVersion: 1,
      expectedWorkspaceId: options.expectedWorkspaceId ?? WORKSPACE_ID,
      clientInstanceId: "route-client",
      events,
    }),
  });
}

describe("harness route with PostgreSQL HarnessIngestionPort", () => {
  it("probe is non-persisting and batch replay returns immutable acknowledgements", async () => {
    const probe = await app.request("/harness/v1/probe", {
      method: "POST",
      headers: {
        authorization: `Bearer ${API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        protocolVersion: 1,
        expectedWorkspaceId: WORKSPACE_ID,
        clientInstanceId: "route-client",
      }),
    });
    expect(probe.status).toBe(200);
    expect((await probe.json()).available).toBe(true);
    const [before] = await raw<{ sessions: number; turns: number; ledger: number }[]>`
      SELECT
        (SELECT count(*)::int FROM mnemosyne.mnemo_session WHERE workspace_id = ${WORKSPACE_ID}) AS sessions,
        (SELECT count(*)::int FROM mnemosyne.mnemo_session_turn WHERE workspace_id = ${WORKSPACE_ID}::uuid) AS turns,
        (SELECT count(*)::int FROM mnemosyne.mnemo_harness_ingestion_event WHERE workspace_id = ${WORKSPACE_ID}) AS ledger
    `;
    expect(before).toEqual({ sessions: 0, turns: 0, ledger: 0 });

    const batch = [startEvent(), appendEvent()];
    const first = await send(batch);
    const firstText = await first.text();
    expect(first.status).toBe(200);
    const replay = await send(batch);
    const replayText = await replay.text();
    expect(replay.status).toBe(200);
    expect(replayText).toBe(firstText);

    const [after] = await raw<{ sessions: number; turns: number; ledger: number }[]>`
      SELECT
        (SELECT count(*)::int FROM mnemosyne.mnemo_session WHERE workspace_id = ${WORKSPACE_ID}) AS sessions,
        (SELECT count(*)::int FROM mnemosyne.mnemo_session_turn WHERE workspace_id = ${WORKSPACE_ID}::uuid) AS turns,
        (SELECT count(*)::int FROM mnemosyne.mnemo_harness_ingestion_event WHERE workspace_id = ${WORKSPACE_ID}) AS ledger
    `;
    expect(after).toEqual({ sessions: 1, turns: 1, ledger: 2 });

    const [provenance] = await raw<
      {
        actor_id: string;
        actor_type: string;
        user_id: string;
        ceiling: string;
      }[]
    >`
      SELECT origin_actor_id AS actor_id, origin_actor_type AS actor_type,
             origin_user_id AS user_id, origin_sensitivity_ceiling AS ceiling
      FROM mnemosyne.mnemo_harness_ingestion_event
      WHERE workspace_id = ${WORKSPACE_ID}
      ORDER BY enqueue_sequence
      LIMIT 1
    `;
    expect(provenance).toEqual({
      actor_id: "key:route-key-row",
      actor_type: "user",
      user_id: "route-user",
      ceiling: "internal",
    });
  });

  it("rejects a future timestamp per item while processing a valid sibling", async () => {
    const future = event({
      eventId: "route-future-event",
      host: "opencode",
      hostSessionId: "route-future-host",
      clientInstanceId: "route-client",
      enqueueSequence: 1,
      occurredAt: new Date(Date.now() + 25 * 60 * 60 * 1000).toISOString(), // determinism-ok: ingestion timestamp is the caller's wall clock; the assertion never depends on its value
      normalizationVersion: 1,
      type: "session.start",
      sensitivity: "internal",
    });
    const valid = sourceStart("route-future-valid", "route-future-valid-host");

    const response = await send([future, valid]);

    expect(response.status).toBe(200);
    expect((await response.json()).acknowledgements).toEqual([
      {
        eventId: "route-future-event",
        status: "rejected",
        retryable: false,
        code: "future_timestamp",
      },
      expect.objectContaining({
        eventId: "route-future-valid",
        status: "accepted",
        retryable: false,
      }),
    ]);
    const [counts] = await raw<Array<{ future_rows: number; valid_sessions: number }>>`
      SELECT
        (SELECT count(*)::int FROM mnemosyne.mnemo_harness_ingestion_event
         WHERE workspace_id = ${WORKSPACE_ID} AND event_id = 'route-future-event') AS future_rows,
        (SELECT count(*)::int FROM mnemosyne.mnemo_session
         WHERE workspace_id = ${WORKSPACE_ID} AND source_session_id = 'route-future-valid-host') AS valid_sessions
    `;
    expect(counts).toEqual({ future_rows: 0, valid_sessions: 1 });
  });

  it("re-evaluates retryable acknowledgements through the real route and freezes the final replay", async () => {
    const hostSessionId = "route-retry-host";
    const turn = sourceAppend("route-retry-turn", hostSessionId, 2, "route-retry-message");
    const start = sourceStart("route-retry-start", hostSessionId);

    const first = await send([turn, start]);
    expect(first.status).toBe(200);
    expect((await first.json()).acknowledgements).toEqual([
      {
        eventId: "route-retry-turn",
        status: "rejected",
        retryable: true,
        code: "missing_session_start",
      },
      expect.objectContaining({
        eventId: "route-retry-start",
        status: "accepted",
        retryable: false,
        effectiveGeneration: 0,
      }),
    ]);

    const second = await send([turn, start]);
    const secondText = await second.text();
    expect(second.status).toBe(200);
    expect(JSON.parse(secondText).acknowledgements).toEqual([
      expect.objectContaining({
        eventId: "route-retry-turn",
        status: "accepted",
        retryable: false,
      }),
      expect.objectContaining({
        eventId: "route-retry-start",
        status: "accepted",
        retryable: false,
      }),
    ]);
    const third = await send([turn, start]);
    expect(await third.text()).toBe(secondText);

    const rows = await raw<
      Array<{
        event_id: string;
        ledger_state: string;
        retry_code: string | null;
        finalized: boolean;
      }>
    >`
      SELECT event_id, ledger_state, retry_code, finalized_at IS NOT NULL AS finalized
      FROM mnemosyne.mnemo_harness_ingestion_event
      WHERE workspace_id = ${WORKSPACE_ID}
        AND event_id IN ('route-retry-turn', 'route-retry-start')
      ORDER BY enqueue_sequence
    `;
    expect(rows).toEqual([
      {
        event_id: "route-retry-start",
        ledger_state: "accepted",
        retry_code: null,
        finalized: true,
      },
      { event_id: "route-retry-turn", ledger_state: "accepted", retry_code: null, finalized: true },
    ]);
  });

  it("returns ordered permanent and accepted sensitivity acknowledgements at the effective ceiling", async () => {
    vi.stubEnv("MNEMO_SENSITIVITY_CEILING", "public");
    const hostSessionId = "route-sensitivity-host";
    try {
      const response = await send([
        sourceStart("route-sensitivity-default", hostSessionId, 1),
        sourceStart("route-sensitivity-public", hostSessionId, 2, "public"),
      ]);
      expect(response.status).toBe(200);
      expect((await response.json()).acknowledgements).toEqual([
        {
          eventId: "route-sensitivity-default",
          status: "rejected",
          retryable: false,
          code: "sensitivity_ceiling_exceeded",
        },
        expect.objectContaining({
          eventId: "route-sensitivity-public",
          status: "accepted",
          retryable: false,
          effectiveGeneration: 0,
        }),
      ]);

      const [session] = await raw<Array<{ sensitivity: string; ceiling: string }>>`
        SELECT sensitivity, origin_sensitivity_ceiling AS ceiling
        FROM mnemosyne.mnemo_session
        WHERE workspace_id = ${WORKSPACE_ID} AND source_session_id = ${hostSessionId}
      `;
      expect(session).toEqual({ sensitivity: "public", ceiling: "public" });
    } finally {
      vi.stubEnv("MNEMO_SENSITIVITY_CEILING", "restricted");
    }
  });

  it("rejects body workspace spoofing and preserves cross-workspace RLS isolation", async () => {
    const shared = sourceStart("route-shared-workspace-event", "route-shared-workspace-host");
    await storage.ingestHarnessEvent({
      workspaceId: OTHER_WORKSPACE_ID,
      provenance: {
        actorId: "key:other-route-key",
        actorType: "agent",
        userId: null,
        sensitivityCeiling: "internal",
      },
      event: shared,
      receivedAt: new Date("2026-09-09T00:00:00.000Z"),
    });
    expect((await send([shared])).status).toBe(200);

    const beforeSpoof = await raw<Array<{ workspace_id: string; count: number }>>`
      SELECT workspace_id::text, count(*)::int
      FROM mnemosyne.mnemo_harness_ingestion_event
      WHERE event_id = ${shared.eventId}
      GROUP BY workspace_id
      ORDER BY workspace_id
    `;
    const spoof = await send([sourceStart("route-spoof-event", "route-spoof-host")], {
      expectedWorkspaceId: OTHER_WORKSPACE_ID,
    });
    expect(spoof.status).toBe(409);
    expect(await spoof.json()).toMatchObject({ error: { code: "workspace_mismatch" } });
    const afterSpoof = await raw<Array<{ workspace_id: string; count: number }>>`
      SELECT workspace_id::text, count(*)::int
      FROM mnemosyne.mnemo_harness_ingestion_event
      WHERE event_id = ${shared.eventId}
      GROUP BY workspace_id
      ORDER BY workspace_id
    `;
    expect(afterSpoof).toEqual(beforeSpoof);
    expect(afterSpoof).toHaveLength(2);

    const hidden = await raw.begin(async (tx) => {
      await tx`SET LOCAL ROLE app_user`;
      await tx`SELECT set_config('app.workspace_id', ${WORKSPACE_ID}, true)`;
      await tx`SELECT set_config('mnemosyne.workspace_id', ${WORKSPACE_ID}, true)`;
      return tx<Array<{ event_id: string }>>`
        SELECT event_id FROM mnemosyne.mnemo_harness_ingestion_event
        WHERE workspace_id = ${OTHER_WORKSPACE_ID}
      `;
    });
    expect(hidden).toEqual([]);
  });

  it("keeps batch cardinality across an item exception and converges on whole-batch retry", async () => {
    const hostSessionId = "route-exception-host";
    const events = [
      sourceStart("route-exception-start", hostSessionId),
      sourceAppend("route-exception-boom", hostSessionId, 2, "route-exception-boom-message"),
      sourceAppend("route-exception-later", hostSessionId, 3, "route-exception-later-message"),
    ];
    let throwOnce = true;
    const storageWithFailure = {
      ingestHarnessEvent: async (input: Parameters<typeof storage.ingestHarnessEvent>[0]) => {
        if (input.event.eventId === "route-exception-boom" && throwOnce) {
          throwOnce = false;
          throw new Error("injected storage failure");
        }
        return storage.ingestHarnessEvent(input);
      },
    };
    const appWithFailure = createApp({
      deps: {
        apiKeys,
        storage: storageWithFailure,
        embedModel: "test",
        telemetry: {
          startSpan: () => ({ setAttribute: () => {}, setStatus: () => {}, end: () => {} }),
          counter: () => {},
          histogram: () => {},
          gauge: () => {},
          shutdown: async () => {},
        },
      } as unknown as ServerDeps,
      version: "harness-route-failure-test",
    });

    const first = await send(events, { targetApp: appWithFailure });
    expect(first.status).toBe(200);
    expect((await first.json()).acknowledgements).toEqual([
      expect.objectContaining({ eventId: "route-exception-start", status: "accepted" }),
      {
        eventId: "route-exception-boom",
        status: "rejected",
        retryable: true,
        code: "ingestion_failed",
      },
      {
        eventId: "route-exception-later",
        status: "rejected",
        retryable: true,
        code: "source_sequence_gap",
      },
    ]);

    const retry = await send(events, { targetApp: appWithFailure });
    expect((await retry.json()).acknowledgements).toEqual([
      expect.objectContaining({ eventId: "route-exception-start", status: "accepted" }),
      expect.objectContaining({ eventId: "route-exception-boom", status: "accepted" }),
      expect.objectContaining({ eventId: "route-exception-later", status: "accepted" }),
    ]);
    const [counts] = await raw<Array<{ ledger: number; turns: number }>>`
      SELECT
        (SELECT count(*)::int FROM mnemosyne.mnemo_harness_ingestion_event
         WHERE workspace_id = ${WORKSPACE_ID}
           AND event_id LIKE 'route-exception-%') AS ledger,
        (SELECT count(*)::int FROM mnemosyne.mnemo_session_turn
         WHERE workspace_id = ${WORKSPACE_ID}::uuid
           AND source_message_id LIKE 'route-exception-%') AS turns
    `;
    expect(counts).toEqual({ ledger: 3, turns: 2 });
  });

  it("ingests chunked >64 KiB UTF-8 turns and 22 assistant turns through POST /harness/v1/events", async () => {
    const hostSessionId = "route-chunked-session";
    const part0 = "alpha-🌟-".repeat(5_500); // ~55 KiB
    const part1 = "omega-🔥-".repeat(3_000); // ~30 KiB
    const fullContent = `${part0}${part1}`;
    const fullHash = sha256Hex(fullContent);

    const chunk0Body = {
      eventId: "route-chunk-0",
      host: "opencode" as const,
      hostSessionId,
      clientInstanceId: "route-client",
      enqueueSequence: 2,
      occurredAt: "2026-09-09T00:00:01.000Z",
      normalizationVersion: 1 as const,
      type: "turn.append" as const,
      sourceGeneration: 0,
      hostMessageId: "route-large-msg",
      role: "assistant" as const,
      content: part0,
      contentHash: sha256Hex(part0),
      chunk: {
        version: 1 as const,
        chunkIndex: 0,
        chunkCount: 2,
        messageContentHash: fullHash,
      },
    };
    const chunk1Body = {
      eventId: "route-chunk-1",
      host: "opencode" as const,
      hostSessionId,
      clientInstanceId: "route-client",
      enqueueSequence: 3,
      occurredAt: "2026-09-09T00:00:02.000Z",
      normalizationVersion: 1 as const,
      type: "turn.append" as const,
      sourceGeneration: 0,
      hostMessageId: "route-large-msg",
      role: "assistant" as const,
      content: part1,
      contentHash: sha256Hex(part1),
      chunk: {
        version: 1 as const,
        chunkIndex: 1,
        chunkCount: 2,
        messageContentHash: fullHash,
      },
    };

    const extraTurns: HarnessEvent[] = [];
    for (let i = 1; i <= 21; i += 1) {
      const content = `Assistant reply #${i} without truncation`;
      const b = {
        eventId: `route-extra-${i}`,
        host: "opencode" as const,
        hostSessionId,
        clientInstanceId: "route-client",
        enqueueSequence: 3 + i,
        occurredAt: "2026-09-09T00:00:03.000Z",
        normalizationVersion: 1 as const,
        type: "turn.append" as const,
        sourceGeneration: 0,
        hostMessageId: `route-msg-${i}`,
        role: "assistant" as const,
        content,
        contentHash: sha256Hex(content),
      };
      extraTurns.push({ ...b, payloadHash: sha256Hex(canonicalJson(b)) });
    }

    const res = await send([
      sourceStart("route-chunk-start", hostSessionId, 1),
      { ...chunk0Body, payloadHash: sha256Hex(canonicalJson(chunk0Body)) },
      { ...chunk1Body, payloadHash: sha256Hex(canonicalJson(chunk1Body)) },
      ...extraTurns,
    ]);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.acknowledgements.every((a: { status: string }) => a.status === "accepted")).toBe(
      true
    );

    const turns = await raw<Array<{ source_message_id: string; content: string; content_hash: string }>>`
      SELECT source_message_id, content, content_hash
      FROM mnemosyne.mnemo_session_turn t
      JOIN mnemosyne.mnemo_session s
        ON s.workspace_id = t.ingestion_event_workspace_id AND s.id = t.session_id
      WHERE s.workspace_id = ${WORKSPACE_ID}
        AND s.source_session_id = ${hostSessionId}
      ORDER BY t.turn_index ASC
    `;
    expect(turns).toHaveLength(22);
    expect(turns[0]?.source_message_id).toBe("route-large-msg");
    expect(turns[0]?.content).toBe(fullContent);
    expect(turns[0]?.content_hash).toBe(fullHash);
  });
});
