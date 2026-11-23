/**
 * WP9 / F13 — Import round-trip fidelity.
 *
 * Build a gzip JSONL payload containing the header plus one line of each of the
 * 15 exported entity types (export.ts dumpEntities sequence). Import it into a
 * FRESH workspace backed by InMemoryStorageAdapter and assert per-type fidelity:
 * the 13 importable types are written; citation + webhook_endpoint are EXPLICITLY
 * skipped (counted with a reason, never silently). Then import a second time to
 * prove idempotency.
 */
import { describe, it, expect } from "vitest";
import { gzipSync } from "node:zlib";
import bcrypt from "bcrypt";
import { BCRYPT_COST } from "../auth.js";
import type { ApiKeyLookup } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";
import { mountImport } from "../routes/import-route.js";
import { JSONL_FORMAT_VERSION } from "../routes/export.js";
import { buildMountHarness } from "./_mountHarness.js";

const PLAINTEXT_KEY = "mns_live_importroundtriptest0001";
const WS_ID = "00000000-0000-0000-0000-000000000019";

async function makeKeyLookup(): Promise<ApiKeyLookup> {
  const keyHash = await bcrypt.hash(PLAINTEXT_KEY, BCRYPT_COST);
  return {
    listActive: async () => [
      { id: "key001", keyHash, workspaceId: WS_ID, scopes: ["memory:write"] },
    ],
    findByLookupHash: undefined,
    setLookupHash: undefined,
    touch: async () => {},
  } as unknown as ApiKeyLookup;
}

function authed() {
  return {
    authorization: `Bearer ${PLAINTEXT_KEY}`,
    "content-type": "application/octet-stream",
  };
}

/** Build a gzip JSONL buffer: header line + one line per type. */
function buildFixture(): Buffer {
  const lines: Record<string, unknown>[] = [
    { _type: "header", version: JSONL_FORMAT_VERSION, workspaceId: "ws-source", embeddingsExcluded: true },
    { _type: "fact", id: "f1", statement: "the sky is blue", subject: "sky", kind: "other", confidence: 0.9 },
    { _type: "decision", id: "dc1", kind: "architecture", title: "Use Postgres", body: "Relational is better here" },
    { _type: "episode", id: "e1", title: "Day one", narrative: "we shipped", occurredAt: "2026-01-01T00:00:00.000Z" },
    { _type: "entity", id: "en1", name: "Alice", kind: "person" },
    { _type: "strategy", id: "sg1", trigger: "deploy fails", action: "ping ops" },
    { _type: "workflow", id: "wf1", name: "Onboard user", steps: [{ id: "s1", name: "Send welcome", action: "email" }] },
    { _type: "skill", id: "sk1", name: "sql-gen", promptTemplate: "write SQL for {goal}" },
    { _type: "reminder", id: "rm1", content: "ping ops", condition: "deploy fails", triggerAt: "2026-02-01T00:00:00.000Z" },
    { _type: "task", id: "t1", title: "ship import", priority: "high", assignedTo: "alice", status: "pending" },
    { _type: "event", id: "ev1", type: "system", name: "boot", description: "server started", occurredAt: "2026-01-02T00:00:00.000Z", source: "kernel" },
    { _type: "reasoning", id: "rs1", question: "why?", chain: [{ step: 1, reasoning: "because" }], conclusion: "so" },
    { _type: "hyperedge", id: "h1", memberIds: ["a", "b", "c"], label: "trio" },
    // webhook_endpoint as exported: secret is REDACTED → must be skipped explicitly.
    { _type: "webhook_endpoint", id: "wh1", url: "https://x", events: ["fact.created"], secretHash: "[REDACTED]" },
    // relation in LEGACY exporter shape (snake_case) → must map onto createRelation.
    { _type: "relation", id: "rel1", source_kind: "fact", source_id: "f1", target_kind: "fact", target_id: "f2", relation: "related", confidence: 0.7 },
    // citation: no storage write path → must be skipped explicitly.
    { _type: "citation", id: "c1", memory_kind: "fact", memory_id: "f1", source_kind: "message", source_id: "m1" },
  ];
  const plain = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  return gzipSync(Buffer.from(plain, "utf8"));
}

function makeDeps(storage: InMemoryStorageAdapter): ServerDeps {
  return {
    core: { recall: async () => [] } as unknown as ServerDeps["core"],
    apiKeys: undefined as unknown as ApiKeyLookup, // set per-test
    embedModel: "text-embedding-3-small",
    storage: storage as unknown as ServerDeps["storage"],
  } as unknown as ServerDeps;
}

interface ImportSummary {
  imported: Record<string, number>;
  skipped: number;
  skippedByReason: Record<string, Record<string, number>>;
  errors: number;
}

describe("WP9 / F13 — import round-trip fidelity", () => {
  it("imports all 13 importable types and explicitly skips citation + webhook_endpoint", async () => {
    const storage = new InMemoryStorageAdapter();
    const deps = makeDeps(storage);
    deps.apiKeys = await makeKeyLookup();
    const app = buildMountHarness(deps, [mountImport]);

    const res = await app.request("/import", {
      method: "POST",
      headers: authed(),
      body: buildFixture(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ImportSummary;

    // 13 importable types each landed exactly once.
    for (const t of ["fact", "decision", "episode", "entity", "strategy", "workflow", "skill", "reminder", "task", "event", "reasoning", "hyperedge", "relation"]) {
      expect(body.imported[t]).toBe(1);
    }

    // The two unwritable types were skipped EXPLICITLY with the documented reasons.
    expect(body.skippedByReason["citation"]?.["no-import-path"]).toBe(1);
    expect(body.skippedByReason["webhook_endpoint"]?.["secret-redacted"]).toBe(1);
    expect(body.errors).toBe(0);

    // Storage actually received the rows (not just counted).
    const tasks = await storage.queryTasks({ workspaceId: WS_ID });
    expect(tasks.items).toHaveLength(1);
    const events = await storage.queryEvents({ workspaceId: WS_ID });
    expect(events.items).toHaveLength(1);
    const reasoning = await storage.queryReasoning({ workspaceId: WS_ID });
    expect(reasoning.items).toHaveLength(1);
    const hyperedges = await storage.queryHyperedges({ workspaceId: WS_ID });
    expect(hyperedges.items).toHaveLength(1);
    const relations = await storage.getRelations({ workspaceId: WS_ID });
    expect(relations).toHaveLength(1);
    expect(relations[0]!.verb).toBe("related");
    expect(relations[0]!.sourceId).toBe("f1");
    expect(relations[0]!.targetId).toBe("f2");
  });

  it("is idempotent on a second import of the same payload (conflictResolution=skip default)", async () => {
    const storage = new InMemoryStorageAdapter();
    const deps = makeDeps(storage);
    deps.apiKeys = await makeKeyLookup();
    const app = buildMountHarness(deps, [mountImport]);

    const payload = buildFixture();
    const first = await app.request("/import", { method: "POST", headers: authed(), body: payload });
    expect(first.status).toBe(200);

    const second = await app.request("/import", { method: "POST", headers: authed(), body: buildFixture() });
    expect(second.status).toBe(200);
    const body2 = (await second.json()) as ImportSummary;

    // Create-once types: the event already exists by id → reported immutable-exists, not re-created.
    expect(body2.skippedByReason["event"]?.["immutable-exists"]).toBe(1);

    // Facts upsert by topic-key (createFact dedups), so total facts in storage stays 1.
    const facts = await storage.queryFacts({ workspaceId: WS_ID });
    expect(facts.items).toHaveLength(1);
    // Events never duplicated.
    const events = await storage.queryEvents({ workspaceId: WS_ID });
    expect(events.items).toHaveLength(1);
  });
});
