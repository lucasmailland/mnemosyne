/**
 * APP-020 — what a recall costs the caller in context.
 *
 * The response an MCP client receives is the rendered text PLUS
 * `structuredContent`, so both are measured. `BEFORE` is what the same fixtures
 * measured on the code this change replaced (pretty-printed JSON, the raw wire
 * payload repeated as `structuredContent`, hits printed under
 * `nothingRelevant=true`); the assertions keep the saving from eroding.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MnemosyneClient } from "@mnemo-ai/client-ts";
import { registerAllTools } from "../../registry.js";

type Result = {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
};

function handlerFor(tool: string, client: Record<string, unknown>) {
  const server = new McpServer({ name: "economy", version: "0.0.0" });
  const handlers = new Map<string, (args: Record<string, unknown>) => Promise<Result>>();
  const original = server.registerTool.bind(server);
  vi.spyOn(server, "registerTool").mockImplementation((name, config, cb) => {
    handlers.set(name, cb as never);
    return original(name, config, cb);
  });
  const c: Record<string, unknown> = { ...client };
  c.withObservation = () => c;
  registerAllTools(server, c as unknown as MnemosyneClient);
  return handlers.get(tool)!;
}

const size = (r: Result) => ({
  text: r.content[0]!.text.length,
  total:
    r.content[0]!.text.length +
    (r.structuredContent ? JSON.stringify(r.structuredContent).length : 0),
});

/** A hit as `POST /recall` sends it with `projection: "compact"`. */
function wireHit(n: number, kind: string, content: string, similarity: number) {
  return {
    id: `0a85f03b-7375-40fd-8f1b-95df3abb02e${n}`,
    kind,
    content: content.slice(0, 300),
    ...(content.length > 300 ? { truncated: true } : {}),
    score: similarity * 1.0123456789012345,
    similarity,
    validFrom: "2026-11-22T07:16:13.170Z",
    validTo: null,
    tags: [],
    sensitivity: "internal",
    actorId: "key:key_aafb8699b795d4304804f142",
    userId: null,
    hitFreshness: "current",
    ...(kind === "fact" ? { topicKey: "infra/staging-db", subject: "staging database" } : {}),
    status: "active",
    trust: "untrusted",
    injectionScore: 0,
  };
}

const LONG = "The staging database runs Postgres 17 with pgvector on port 5545. ".repeat(8);
const HITS = [
  wireHit(1, "fact", LONG, 0.8126519377670385),
  wireHit(2, "decision", LONG, 0.7742735555837425),
  wireHit(
    3,
    "strategy",
    "A migration fails checksum validation → stop and diff it",
    0.7096653854791023
  ),
  wireHit(
    4,
    "fact",
    "Larkspur Robotics prefers all customer communication in Spanish.",
    0.6667556139744492
  ),
  wireHit(5, "workflow", LONG, 0.6138301340875873),
];
const DEBUG = { embedded: true, latencyMs: 41, searchMode: "auto" };

const REMEMBERED = {
  id: "4ec24226-54f9-4d70-a8a8-925de6daeabd",
  workspaceId: "ed16fc64-2add-43f1-93a3-1f94265aa4cc",
  actorId: "key:key_aafb8699b795d4304804f142",
  userId: null,
  statement: "Larkspur Robotics prefers all customer communication in Spanish.",
  confidence: 1,
  topicKey: null,
  status: "active",
  sensitivity: "internal",
  pinned: false,
  attribution: {},
  tags: ["preference"],
  validFrom: "2026-11-22T07:15:37.051Z",
  validTo: null,
  createdAt: "2026-11-22T07:15:37.051Z",
  embeddingDeferred: true,
};

/** Measured on the replaced code with these same fixtures (text / text+structured). */
const BEFORE = {
  recall5: { text: 3086, total: 6279 },
  nothingRelevant: { text: 3085, total: 6277 },
  remember: { text: 555, total: 1037 },
};

describe("APP-020 recall output economy", () => {
  it("a 5-hit compact recall no longer repeats the wire payload", async () => {
    const recall = vi.fn(async () => ({ hits: HITS, nothingRelevant: false, debug: DEBUG }));
    const res = await handlerFor("memory_recall", { recall })({
      query: "staging db",
      requestId: "r1",
    });
    const after = size(res);
    console.info("recall5", after);
    // The wire hits are already compact, so the saving is the dropped wire
    // fields in structuredContent and the rounded scores: 6279 -> 5475 (-13%).
    expect(after.total).toBeLessThan(BEFORE.recall5.total * 0.9);
    // The structured hits are the compact field set the text shows.
    const memories = res.structuredContent!.memories as Array<Record<string, unknown>>;
    expect(memories).toHaveLength(5);
    expect(memories[0]).not.toHaveProperty("actorId");
    expect(memories[0]).not.toHaveProperty("tags");
    expect(memories[0]).toMatchObject({ kind: "fact", truncated: true, similarity: 0.813 });
    expect(res.content[0]!.text).toContain('"similarity":0.813');
  });

  it("nothingRelevant prints one short line and no hits, in recall and search", async () => {
    const recall = vi.fn(async () => ({ hits: HITS, nothingRelevant: true, debug: DEBUG }));
    for (const tool of ["memory_recall", "memory_search"]) {
      const res = await handlerFor(tool, { recall })({
        query: "checkout timeout",
        requestId: "r1",
      });
      const after = size(res);
      if (tool === "memory_recall") console.info("nothingRelevant", after);
      expect(res.isError).toBeUndefined();
      expect(res.content[0]!.text).not.toContain("untrusted_context");
      expect(res.content[0]!.text).not.toContain("staging database");
      expect(res.content[0]!.text.split("\n")).toHaveLength(1);
      expect(res.structuredContent).toMatchObject({ memories: [], nothingRelevant: true });
      expect(JSON.stringify(res.structuredContent)).not.toContain("staging database");
      expect(after.total).toBeLessThan(BEFORE.nothingRelevant.total * 0.1);
    }
  });

  it("keeps reminders visible when nothing is relevant", async () => {
    const reminders = [{ id: "rem_1", message: "renew the cert" }];
    const recall = vi.fn(async () => ({ hits: HITS, nothingRelevant: true, reminders }));
    const res = await handlerFor("memory_recall", { recall })({ query: "q" });
    expect(res.content[0]!.text).toContain("renew the cert");
    expect(res.content[0]!.text).not.toContain("untrusted_context");
    expect(res.structuredContent).toMatchObject({ reminders });
  });

  it("memory_search asks for the compact projection and prints the full-text hint", async () => {
    const recall = vi.fn(async () => ({ hits: HITS, nothingRelevant: false, debug: DEBUG }));
    const res = await handlerFor("memory_search", { recall })({ query: "staging db" });
    expect(recall).toHaveBeenCalledWith(expect.objectContaining({ projection: "compact" }));
    expect(res.content[0]!.text).toContain("memory_fact(");
    // APP-019b round 2: memory_fact (in core) opens a workflow too.
    expect(res.content[0]!.text).toContain('"kind":"workflow"})');
    const memories = res.structuredContent!.memories as Array<Record<string, unknown>>;
    expect(memories[0]).not.toHaveProperty("actorId");
    expect(res.structuredContent!.debug).toEqual(DEBUG);
  });

  it("memory_remember answers in compact JSON", async () => {
    const remember = vi.fn(async () => REMEMBERED);
    const res = await handlerFor("memory_remember", { remember })({ statement: "x" });
    const after = size(res);
    console.info("remember", after);
    expect(res.content[0]!.text).toBe(JSON.stringify(REMEMBERED));
    expect(after.text).toBeLessThan(BEFORE.remember.text);
  });

  it("no tool pretty-prints JSON: they all go through jsonText", () => {
    const dir = fileURLToPath(new URL("../../tools/", import.meta.url));
    const offenders = readdirSync(dir)
      .filter((file) => file.endsWith(".ts") && file !== "json-text.ts")
      .filter((file) =>
        /JSON\.stringify\([^)]*,\s*null\s*,/.test(readFileSync(dir + file, "utf8"))
      );
    expect(offenders).toEqual([]);
  });
});
