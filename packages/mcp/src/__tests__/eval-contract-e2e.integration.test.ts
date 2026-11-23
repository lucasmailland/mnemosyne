/**
 * Integration of the 2026-10-17 evaluation fixes (WP-8 review): the recall
 * contract WP-3 added on the server, the fact fields WP-5 added and the
 * relation filters WP-6 added are only worth something if they reach the
 * agent. This walks the real chain end to end — HTTP server on real
 * Postgres → @mnemo-ai/client-ts → the built MCP stdio server — and checks
 * what the MCP tools hand back.
 *
 * Requires Docker, Node 22 and built dist/ for core, adapter-postgres,
 * server, client-ts and mcp (see harness/live-surface.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startLiveSurface, type LiveSurface } from "./harness/live-surface.js";
import { callToolOk } from "./coverage-guard/mcp-tool-helpers.js";

let surface: LiveSurface;

beforeAll(async () => {
  surface = await startLiveSurface();
}, 180_000);

afterAll(async () => {
  await surface?.close();
});

async function post(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await surface.http("POST", path, {
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

async function remember(statement: string, extra: Record<string, unknown> = {}): Promise<string> {
  const res = await post("/remember", { statement, ...extra });
  expect(res.status).toBe(201);
  return res.json.id as string;
}

async function relate(sourceId: string, targetId: string, relation: string): Promise<string> {
  const res = await post("/relations", {
    sourceKind: "fact",
    sourceId,
    targetKind: "fact",
    targetId,
    relation,
    markedByKind: "agent",
  });
  expect(res.status).toBe(201);
  return res.json.id as string;
}

describe("eval contract reaches the MCP output", () => {
  it("a recall hit keeps kind, topicKey, subject, status/contested and similarity", async () => {
    const contested = await remember("e2e kestrel: the ledger database is PostgreSQL 17.", {
      subject: "kestrel",
      topicKey: "kestrel/ledger-db",
      scopeRef: "kestrel",
    });
    const rival = await remember("e2e kestrel: the ledger database is MySQL 8.", {
      subject: "kestrel",
    });
    await relate(contested, rival, "conflicts_with");

    const out = await callToolOk(surface.mcp, "memory_recall", {
      query: "e2e kestrel ledger database",
      limit: 25,
    });
    const body = out.structuredContent as {
      memories: Array<Record<string, unknown>>;
      nothingRelevant?: boolean;
    };
    expect(typeof body.nothingRelevant).toBe("boolean");
    const hit = body.memories.find((m) => m.id === contested);
    expect(hit).toBeDefined();
    expect(hit).toMatchObject({
      kind: "fact",
      topicKey: "kestrel/ledger-db",
      subject: "kestrel",
      scopeRef: "kestrel",
      status: "contested",
    });
    expect(typeof hit!.similarity).toBe("number");

    // The text the model reads carries the same fields, inside the untrusted wrapper.
    const text = out.content.map((c) => c.text).join("\n");
    const line = text.split("\n").find((l) => l.includes(contested));
    expect(line).toBeDefined();
    expect(line).toContain("<untrusted_context>");
    for (const fragment of [
      '"kind":"fact"',
      '"topicKey":"kestrel/ledger-db"',
      '"subject":"kestrel"',
      '"status":"contested"',
      '"similarity":',
    ]) {
      expect(line).toContain(fragment);
    }
  });

  it("memory_fact returns the fact's metadata, not only its statement", async () => {
    const id = await remember("e2e orion: the payments api deploys with ArgoCD.", {
      subject: "orion",
      topicKey: "orion/deploy-method",
      scopeRef: "orion",
    });
    const out = await callToolOk(surface.mcp, "memory_fact", { factId: id });
    const fact = out.structuredContent as Record<string, unknown>;
    expect(fact).toMatchObject({
      id,
      subject: "orion",
      topicKey: "orion/deploy-method",
      scopeRef: "orion",
      status: "active",
    });
    expect(fact.kind).toBeDefined();
    expect(typeof fact.revisionCount).toBe("number");
  });

  it("memory_relate list from:X returns only X's relations", async () => {
    const x = await remember("e2e relate: node X");
    const y = await remember("e2e relate: node Y");
    const z = await remember("e2e relate: node Z");
    const xy = await relate(x, y, "related");
    const xz = await relate(x, z, "part_of");
    const yz = await relate(y, z, "related");

    const out = await callToolOk(surface.mcp, "memory_relate", { action: "list", from: x });
    const items = (out.structuredContent as { items: Array<{ id: string; sourceId: string }> })
      .items;
    expect(items.map((r) => r.id).sort()).toEqual([xy, xz].sort());
    expect(items.every((r) => r.sourceId === x)).toBe(true);
    expect(items.map((r) => r.id)).not.toContain(yz);
  });
});
