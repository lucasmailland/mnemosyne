/**
 * MNEMO_SENSITIVE_TEXT_TO_PROVIDERS=none (SECURITY.md §7) as the application
 * role (NOSUPERUSER NOBYPASSRLS): nothing re-embeds a confidential+ row later.
 *
 *   - The outbox worker re-reads the row's tier before embedding a text-form
 *     job and leaves a confidential decision unembedded (the entry is
 *     processed, the embedder never sees the text).
 *   - The re-embed sweep (`listStaleEmbeddings` with `plaintextOnly`) never
 *     lists it.
 *   - A local embedder, or the default policy, still embeds it.
 *
 * Runs via `test:integration` (needs Docker).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import postgres from "postgres";
import type { EmbedAdapter, SensitiveTextPolicy } from "@mnemo-ai/types";
import { createDrizzleClient, DrizzleStorageAdapter } from "../DrizzleStorageAdapter.js";
import { migrate } from "../migrate.js";
import { OutboxWorker } from "../OutboxWorker.js";

const PG_IMAGE = "pgvector/pgvector:pg17";
const PG_DB = "mnemo_test";
const APP_USER = "egress_app";
const APP_PASS = "egress_app_pass";
const SECRET = "Larkspur Robotics pays its contractors through Acme Bank";
const PLAIN = "Larkspur Robotics ships on Thursdays";

let container: StartedTestContainer;
let superSql: ReturnType<typeof postgres>;
let app: ReturnType<typeof createDrizzleClient>;
let storage: DrizzleStorageAdapter;
// The worker claims outbox rows FOR UPDATE, which mnemo_app_role is not
// granted on mnemo_outbox; it drains through the owner connection here. Every
// query this change adds (the tier read, the plaintext-only sweep) runs as the
// app role through `storage`.
let owner: ReturnType<typeof createDrizzleClient>;
let ownerStorage: DrizzleStorageAdapter;

const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  child() {
    return this;
  },
};

function recordingEmbed(local = false): EmbedAdapter & { seen: string[] } {
  const seen: string[] = [];
  return {
    id: "rec-embed",
    model: "rec-embed-model",
    dimensions: 1536,
    ...(local ? { local: true } : {}),
    seen,
    async embed(texts: string[]) {
      seen.push(...texts);
      return texts.map(() => new Float32Array(1536).fill(0.125));
    },
    async embedSingle(text: string) {
      seen.push(text);
      return new Float32Array(1536).fill(0.125);
    },
    async healthCheck() {
      return { status: "ok" as const, latencyMs: 0 };
    },
  };
}

async function seedDecisions(workspaceId: string) {
  const secret = await storage.createDecision({
    workspaceId,
    kind: "decision",
    title: "Payroll bank",
    body: SECRET,
    sensitivity: "confidential",
  });
  const plain = await storage.createDecision({
    workspaceId,
    kind: "decision",
    title: "Release day",
    body: PLAIN,
    sensitivity: "internal",
  });
  return { secret, plain };
}

async function drain(policy: SensitiveTextPolicy | undefined, embed: EmbedAdapter) {
  const worker = new OutboxWorker(
    {
      ...Object.fromEntries(
        ["claimOutbox", "markOutboxProcessed", "markOutboxFailed", "reapDeadLetters"].map((m) => [
          m,
          (ownerStorage as never as Record<string, (...a: unknown[]) => unknown>)[m]!.bind(
            ownerStorage
          ),
        ])
      ),
      getEmbeddingSourceSensitivity: storage.getEmbeddingSourceSensitivity.bind(storage),
      updateEmbeddingVector: storage.updateEmbeddingVector.bind(storage),
    } as never,
    { upsert: async () => undefined } as never,
    { deletePattern: async () => 0 } as never,
    { enqueue: async () => undefined } as never,
    logger,
    policy ? { sensitiveTextToProviders: policy } : {},
    embed
  );
  while ((await worker.runBatch()) > 0) {
    /* drain everything claimable */
  }
}

async function embedded(id: string): Promise<boolean> {
  const [row] = await superSql<Array<{ has: boolean }>>`
    SELECT embedding IS NOT NULL AS has FROM mnemosyne.mnemo_decision WHERE id::text = ${id}
  `;
  return row!.has;
}

beforeAll(async () => {
  container = await new GenericContainer(PG_IMAGE)
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
    ALTER ROLE ${APP_USER} SET search_path = mnemosyne, public;
  `);
  app = createDrizzleClient(`postgres://${APP_USER}:${APP_PASS}@${host}:${port}/${PG_DB}`);
  storage = new DrizzleStorageAdapter(app.db, app.pgClient);
  owner = createDrizzleClient(superUrl);
  ownerStorage = new DrizzleStorageAdapter(owner.db, owner.pgClient);
}, 120_000);

afterAll(async () => {
  await app?.pgClient.end().catch(() => void 0);
  await owner?.pgClient.end().catch(() => void 0);
  await superSql?.end().catch(() => void 0);
  await container?.stop().catch(() => void 0);
});

describe("sensitive text and the embedder after the write", () => {
  it("none: the outbox worker never embeds a confidential row, and still embeds the rest", async () => {
    const ws = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaee01";
    const { secret, plain } = await seedDecisions(ws);
    const embed = recordingEmbed();

    await drain("none", embed);

    expect(embed.seen.some((t) => t.includes(SECRET))).toBe(false);
    expect(embed.seen.some((t) => t.includes(PLAIN))).toBe(true);
    expect(await embedded(secret.id)).toBe(false);
    expect(await embedded(plain.id)).toBe(true);
    // Skipped on purpose, not left to retry and dead-letter.
    const pending = await superSql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM mnemosyne.mnemo_outbox
      WHERE workspace_id = ${ws} AND processed_at IS NULL
    `;
    expect(pending[0]!.n).toBe(0);
    expect(await storage.getEmbeddingSourceSensitivity("decision", secret.id, ws)).toBe(
      "confidential"
    );
  });

  it("none: the re-embed sweep never lists a confidential row", async () => {
    const ws = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaee02";
    const { secret, plain } = await seedDecisions(ws);
    const all = await storage.listStaleEmbeddings("decision", ws, "rec-embed-model", 100);
    const plaintext = await storage.listStaleEmbeddings("decision", ws, "rec-embed-model", 100, {
      plaintextOnly: true,
    });
    expect(all.map((r) => r.id).sort()).toEqual([secret.id, plain.id].sort());
    expect(plaintext.map((r) => r.id)).toEqual([plain.id]);
  });

  it.each([
    ["embed (default)", undefined, false],
    ["none with a local embedder", "none", true],
  ] as const)("%s: the confidential row is embedded", async (_name, policy, local) => {
    const ws = local
      ? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaee03"
      : "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaee04";
    const { secret } = await seedDecisions(ws);
    const embed = recordingEmbed(local);
    await drain(policy, embed);
    expect(embed.seen.some((t) => t.includes(SECRET))).toBe(true);
    expect(await embedded(secret.id)).toBe(true);
  });
});
