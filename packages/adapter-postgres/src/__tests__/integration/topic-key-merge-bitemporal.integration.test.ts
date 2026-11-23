import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { createDrizzleClient, DrizzleStorageAdapter } from "../../DrizzleStorageAdapter.js";
import { migrate } from "../../migrate.js";

/**
 * P76 — a `topicKey` merge must leave history behind.
 *
 * It used to be a plain in-place UPDATE of `statement`: no interval close, no
 * successor row, no `supersedes` relation, only `revisionCount + 1`. That is
 * overwrite-without-history — precisely the behaviour this project criticises in
 * Engram — in the one place we also did it. And it landed where it hurts most:
 * `topicKey` is the idempotent update path the SKILL.md recommends, so it hit
 * the facts that get corrected the most, and each correction erased the claim it
 * replaced.
 *
 * `mergeFactByTopicKey` now shares `supersedeActiveFact` with `replaceFact`, so
 * there is ONE bitemporal implementation rather than two to keep in step.
 */

const PG_IMAGE = "pgvector/pgvector:pg17";
const PG_USER = "mnemo_test";
const PG_PASSWORD = "mnemo_test";
const PG_DB = "mnemo_test";

describe("mergeFactByTopicKey — bitemporal supersede", () => {
  let container: StartedTestContainer;
  let sql: ReturnType<typeof postgres>;
  let adapter: DrizzleStorageAdapter;
  let client: ReturnType<typeof createDrizzleClient>;

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
    const url = `postgres://${PG_USER}:${PG_PASSWORD}@${container.getHost()}:${container.getMappedPort(
      5432
    )}/${PG_DB}`;
    await migrate({ databaseUrl: url, log: () => undefined });
    sql = postgres(url, { max: 5 });
    client = createDrizzleClient(url);
    adapter = new DrizzleStorageAdapter(client.db, client.pgClient);
  }, 120_000);

  afterAll(async () => {
    await client?.pgClient.end();
    await sql?.end();
    await container?.stop();
  });

  async function seed(workspaceId: string, topicKey: string, statement: string) {
    return adapter.createFact({
      workspaceId,
      scope: "global",
      statement,
      subject: "infra",
      kind: "other",
      sensitivity: "internal",
      topicKey,
      tags: ["original"],
      metadata: { owner: "infra", tags: ["original"] },
    });
  }

  it("closes the previous interval instead of overwriting it", async () => {
    const workspaceId = crypto.randomUUID();
    const first = await seed(workspaceId, "cache/engine", "El cache corre sobre Redis.");

    const merged = await adapter.mergeFactByTopicKey({
      workspaceId,
      topicKey: "cache/engine",
      statement: "El cache corre sobre Valkey.",
    });

    expect(merged).not.toBeNull();
    // A NEW row, not the old one mutated. This is the assertion the old
    // implementation could never satisfy.
    expect(merged!.id).not.toBe(first.id);

    const rows = await sql<
      Array<{ id: string; statement: string; status: string; vt: Date | null }>
    >`
      SELECT id, statement, status, valid_to AS vt
        FROM mnemosyne.mnemo_fact
       WHERE workspace_id = ${workspaceId}
       ORDER BY created_at
    `;
    expect(rows).toHaveLength(2);

    const previous = rows.find((r) => r.id === first.id)!;
    const successor = rows.find((r) => r.id === merged!.id)!;

    // The superseded claim is still readable — that is the whole point.
    expect(previous.statement).toBe("El cache corre sobre Redis.");
    expect(previous.status).toBe("forgotten");
    expect(previous.vt).not.toBeNull();

    expect(successor.statement).toBe("El cache corre sobre Valkey.");
    expect(successor.status).toBe("active");
    expect(successor.vt).toBeNull();
  });

  it("links successor to predecessor with a `supersedes` relation", async () => {
    const workspaceId = crypto.randomUUID();
    const first = await seed(workspaceId, "broker", "El broker es Kafka.");
    const merged = await adapter.mergeFactByTopicKey({
      workspaceId,
      topicKey: "broker",
      statement: "El broker es NATS.",
    });

    const [rel] = await sql<Array<{ source_id: string; target_id: string; relation: string }>>`
      SELECT source_id, target_id, relation
        FROM mnemosyne.mnemo_relation
       WHERE workspace_id = ${workspaceId} AND relation = 'supersedes'
    `;
    // Without this edge the two rows are unrelated strangers and "why did this
    // change?" is unanswerable from the graph.
    expect(rel?.source_id).toBe(merged!.id);
    expect(rel?.target_id).toBe(first.id);
  });

  it("carries the topicKey forward so the next merge still finds it", async () => {
    // If the successor lost its topicKey, the second correction would insert a
    // duplicate instead of superseding — idempotency would break on write #2.
    const workspaceId = crypto.randomUUID();
    await seed(workspaceId, "region", "Corremos en us-east-1.");
    const second = await adapter.mergeFactByTopicKey({
      workspaceId,
      topicKey: "region",
      statement: "Corremos en sa-east-1.",
    });
    const third = await adapter.mergeFactByTopicKey({
      workspaceId,
      topicKey: "region",
      statement: "Corremos en eu-west-1.",
    });

    expect(third).not.toBeNull();
    expect(third!.id).not.toBe(second!.id);
    expect(third!.revisionCount).toBe(3);

    const [{ n }] = await sql<Array<{ n: number }>>`
      SELECT COUNT(*)::int AS n FROM mnemosyne.mnemo_fact
       WHERE workspace_id = ${workspaceId} AND valid_to IS NULL AND status = 'active'
    `;
    // Exactly one live row per topic — the idempotency contract still holds.
    expect(n).toBe(1);
  });

  it("merges metadata and unions tags onto the successor", async () => {
    const workspaceId = crypto.randomUUID();
    await seed(workspaceId, "storage", "Usamos S3.");

    const merged = await adapter.mergeFactByTopicKey({
      workspaceId,
      topicKey: "storage",
      statement: "Usamos R2.",
      metadata: { owner: "datos", ticket: "OPS-12" },
      tags: ["migracion"],
    });

    const meta = merged!.metadata as Record<string, unknown>;
    // Incoming keys win, untouched source keys survive, tag lists union.
    expect(meta["owner"]).toBe("datos");
    expect(meta["ticket"]).toBe("OPS-12");
    expect(new Set(meta["tags"] as string[])).toEqual(new Set(["original", "migracion"]));
  });

  it("inherits the predecessor's columns rather than resetting them", async () => {
    // A successor that silently drops pinned/scopeRef/episode links would lose
    // curation on every correction — invisible until someone looks for it.
    const workspaceId = crypto.randomUUID();
    const first = await adapter.createFact({
      workspaceId,
      scope: "global",
      scopeRef: "mnemosyne",
      statement: "El deploy es manual.",
      subject: "infra",
      kind: "other",
      sensitivity: "internal",
      topicKey: "deploy",
    });
    // `pinned` is not a CreateFactInput field — it is set later, by curation.
    // Setting it here through SQL is the honest way to build the precondition;
    // passing it to createFact just silently does nothing.
    await sql`UPDATE mnemosyne.mnemo_fact SET pinned = true WHERE id = ${first.id}`;

    const merged = await adapter.mergeFactByTopicKey({
      workspaceId,
      topicKey: "deploy",
      statement: "El deploy es por CI.",
    });

    expect(merged!.pinned).toBe(true);
    expect(merged!.scopeRef).toBe("mnemosyne");
    expect(merged!.subject).toBe(first.subject);
  });

  it("refuses to supersede a row mid-consolidation", async () => {
    // B6.35. The guard used to live in the UPDATE's WHERE; with no UPDATE left
    // it had to move to the SELECT, and losing it would let a merge supersede a
    // row that a consolidation rollback still needs.
    const workspaceId = crypto.randomUUID();
    const first = await seed(workspaceId, "pending", "Estado inicial.");
    await sql`
      UPDATE mnemosyne.mnemo_fact
         SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb),
                                  '{__mnemoConsolidationPending}', ${sql.json({ op: "x" })})
       WHERE id = ${first.id}
    `;

    const merged = await adapter.mergeFactByTopicKey({
      workspaceId,
      topicKey: "pending",
      statement: "No deberia aplicarse.",
    });

    expect(merged).toBeNull();
    const [{ n }] = await sql<Array<{ n: number }>>`
      SELECT COUNT(*)::int AS n FROM mnemosyne.mnemo_fact WHERE workspace_id = ${workspaceId}
    `;
    expect(n).toBe(1);
  });

  it("enqueues a re-embed for the successor, not the closed row", async () => {
    // P76/P111: the merged statement is new text, so its vector has to be
    // recomputed — and against the id that is actually live.
    const workspaceId = crypto.randomUUID();
    await seed(workspaceId, "embed", "Texto viejo.");
    const merged = await adapter.mergeFactByTopicKey({
      workspaceId,
      topicKey: "embed",
      statement: "Texto nuevo.",
    });

    const upserts = await sql<Array<{ payload: Record<string, unknown> }>>`
      SELECT payload FROM mnemosyne.mnemo_outbox
       WHERE workspace_id = ${workspaceId} AND event_type = 'vector_upsert'
    `;
    expect(upserts.some((u) => u.payload["id"] === merged!.id)).toBe(true);
  });
});
