/**
 * APP-015 (audit 2026-11-22) against real Postgres: the context economy read
 * averages the characters each recall served over the window, and sizes only
 * the live plaintext facts of the workspace asked about.
 */
import postgres from "postgres";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RecallRequestObservation } from "@mnemo-ai/types";

import { createDrizzleClient } from "../DrizzleStorageAdapter.js";
import { RecallRepository } from "../repositories/RecallRepository.js";
import { migrate } from "../migrate.js";

let container: StartedTestContainer;
let repo: RecallRepository;
let raw: ReturnType<typeof postgres>;
const WS = "44444444-4444-4444-8444-444444444444";
const OTHER = "55555555-5555-4555-8555-555555555555";

beforeAll(async () => {
  container = await new GenericContainer("pgvector/pgvector:pg17")
    .withEnvironment({ POSTGRES_USER: "u", POSTGRES_PASSWORD: "p", POSTGRES_DB: "d" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
    .start();
  const url = `postgres://u:p@${container.getHost()}:${container.getMappedPort(5432)}/d`;
  await migrate({ databaseUrl: url, log: () => void 0 });
  raw = postgres(url, { max: 2, onnotice: () => void 0 });
  const { db } = createDrizzleClient(url);
  repo = new RecallRepository(db, db);
}, 180_000);

afterAll(async () => {
  await raw?.end().catch(() => void 0);
  await container?.stop().catch(() => void 0);
});

const request = (ws: string, id: string, meta: object, createdAt = "now()") =>
  raw.unsafe(
    `INSERT INTO mnemosyne.mnemo_recall_request
       (workspace_id, request_id, request_metadata, query_hash, status, duration_ms, created_at)
     VALUES ($1::uuid, $2, $3::text::jsonb, 'h', 'ok', 1, ${createdAt})`,
    [ws, id, JSON.stringify(meta)]
  );

/** A row written by the production writer, which is what the read must parse. */
const observed = (ws: string, id: string, servedChars: number) =>
  repo.recordRecallObservation(
    {
      requestId: id,
      workspaceId: ws,
      trafficOrigin: "production",
      clientVersion: "t",
      pluginVersion: "t",
      serverVersion: "t",
      sessionId: null,
      requestedFilters: {},
      effectiveFilters: {},
      tiers: ["cold"],
      cacheHit: false,
      resultCount: 0,
      servedChars,
      nothingRelevant: true,
      status: "ok",
      queryHash: "h",
      totalDurationMs: 1,
      phaseDurationsMs: {},
    } as RecallRequestObservation,
    []
  );

describe("RecallRepository.getContextEconomy — APP-015", () => {
  it("is empty, not zero, before any recall was measured", async () => {
    const e = await repo.getContextEconomy(WS, 7, "internal");
    expect(e).toEqual({
      recalls: 0,
      servedCharsAvg: null,
      servedCharsP95: null,
      liveFacts: 0,
      liveFactChars: 0,
    });
  });

  it("averages served characters in the window and sizes live plaintext facts", async () => {
    await observed(WS, "r1", 100);
    await request(WS, "r2", { servedChars: 300 });
    await request(WS, "r3", {}); // recorded before servedChars existed: not counted
    await request(WS, "r4", { servedChars: 9000 }, "now() - interval '30 days'");
    await request(OTHER, "r5", { servedChars: 5000 });
    await raw`
      INSERT INTO mnemosyne.mnemo_fact (id, workspace_id, scope, kind, subject, statement, sensitivity, valid_to)
      VALUES (gen_random_uuid(), ${WS}, 'global', 'other', 's', ${"a".repeat(40)}, 'internal', NULL),
             (gen_random_uuid(), ${WS}, 'global', 'other', 's', ${"b".repeat(10)}, 'public', NULL),
             (gen_random_uuid(), ${WS}, 'global', 'other', 's', 'ciphertext', 'confidential', NULL),
             (gen_random_uuid(), ${WS}, 'global', 'other', 's', 'forgotten', 'internal', now()),
             (gen_random_uuid(), ${OTHER}, 'global', 'other', 's', 'elsewhere', 'internal', NULL)`;

    const e = await repo.getContextEconomy(WS, 7, "internal");
    expect(e.recalls).toBe(2);
    expect(e.servedCharsAvg).toBe(200);
    expect(e.servedCharsP95).toBe(290);
    expect(e.liveFacts).toBe(2);
    expect(e.liveFactChars).toBe(50);

    // A public-ceiling caller is never told about internal facts.
    const pub = await repo.getContextEconomy(WS, 7, "public");
    expect(pub.liveFacts).toBe(1);
    expect(pub.liveFactChars).toBe(10);
    // A restricted ceiling still sizes plaintext only.
    expect((await repo.getContextEconomy(WS, 7, "restricted")).liveFacts).toBe(2);
  });
});
