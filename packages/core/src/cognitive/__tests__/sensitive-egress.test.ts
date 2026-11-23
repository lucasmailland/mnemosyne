/**
 * MNEMO_SENSITIVE_TEXT_TO_PROVIDERS (SECURITY.md §7): which providers receive
 * the plaintext of confidential+ facts. Every provider here is a fake that
 * records what it was sent; each case asserts the recorded text, per value:
 *
 *   none   embedder no,  completions no
 *   embed  embedder yes, completions no   (the default)
 *   all    embedder yes, completions yes
 *   local providers get it under any value.
 */
import { describe, it, expect } from "vitest";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";
import type { AuthContext, LLMTask, RecallHit, SensitiveTextPolicy } from "@mnemo-ai/types";
import { remember } from "../remember.js";
import { maybeRerank, dedupByContent } from "../recall-cold.js";

const WS = "ws-egress";
const NEW_SECRET = "Larkspur payroll moves to Acme Bank in March";
const OLD_SECRET = "Larkspur payroll stays with Acme Credit Union";

const auth: AuthContext = {
  workspaceId: WS,
  actorId: "key:k1",
  actorType: "agent",
  userId: null,
  scopes: ["memory:write", "memory:admin"] as never,
};

interface Setup {
  policy?: SensitiveTextPolicy;
  embedLocal?: boolean;
  llmLocal?: LLMTask[];
}

/** An embedder and an LLM that remember every text they were given. */
function recordingProviders({ embedLocal, llmLocal }: Setup) {
  const embedded: string[] = [];
  const prompted: string[] = [];
  const embed = {
    id: "rec-embed",
    model: "rec-embed",
    dimensions: 2,
    ...(embedLocal ? { local: true } : {}),
    async embed(texts: string[]) {
      embedded.push(...texts);
      // Orthogonal per text: nothing is a near-duplicate of anything.
      return texts.map((_, i) => Float32Array.from({ length: 8 }, (_v, j) => (j === i ? 1 : 0)));
    },
    async embedSingle(text: string) {
      embedded.push(text);
      return new Float32Array([1, 0]);
    },
    async healthCheck() {
      return { status: "ok" as const, latencyMs: 0 };
    },
  };
  const llm = {
    id: "rec-llm",
    model: "rec-llm",
    ...(llmLocal ? { localTasks: llmLocal } : {}),
    async generate(input: { messages: Array<{ content: string }> }) {
      prompted.push(input.messages.map((m) => m.content).join("\n"));
      return { content: "COMPATIBLE", tokensUsed: { input: 1, output: 1 }, model: "rec-llm" };
    },
    async generateStructured(): Promise<never> {
      throw new Error("unused");
    },
    async healthCheck() {
      return { status: "ok" as const, latencyMs: 0 };
    },
  };
  return { embed, llm, embedded, prompted };
}

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

function ctxFor(setup: Setup, storage = new InMemoryStorageAdapter()) {
  const p = recordingProviders(setup);
  const ctx = {
    storage,
    vector: { search: async () => [], upsert: async () => {} },
    embed: p.embed,
    llm: p.llm,
    telemetry: { startSpan: () => ({ end: () => {} }) },
    logger,
    config: {
      surpriseThreshold: 0,
      maxHotTierSize: 1000,
      worthDecayLambda: 0.1,
      hotTierTtlSeconds: 3600,
      injectionScoreThreshold: 0.85,
      anomalyScoreThreshold: 0.8,
      writeConflictClassification: true,
      ...(setup.policy ? { sensitiveTextToProviders: setup.policy } : {}),
    },
  };
  return { ctx: ctx as never, ...p };
}

function hit(id: string, content: string, score: number, sensitivity: string): RecallHit {
  return {
    id,
    primitive: "fact",
    content,
    score,
    sensitivity,
    embedding: [1, 0, 0],
  } as unknown as RecallHit;
}

const CASES: Array<[string, Setup, { embed: boolean; llm: boolean }]> = [
  ["none", { policy: "none" }, { embed: false, llm: false }],
  ["embed", { policy: "embed" }, { embed: true, llm: false }],
  ["unset (= embed)", {}, { embed: true, llm: false }],
  ["all", { policy: "all" }, { embed: true, llm: true }],
  [
    "none with local providers",
    { policy: "none", embedLocal: true, llmLocal: ["judge"] },
    { embed: true, llm: true },
  ],
  [
    "none with a local judge only for summaries",
    { policy: "none", llmLocal: ["summary"] },
    { embed: false, llm: false },
  ],
];

describe.each(CASES)("MNEMO_SENSITIVE_TEXT_TO_PROVIDERS %s", (_name, setup, expected) => {
  it("remember: the confidential statement reaches the embedder and the write-time judge only as allowed", async () => {
    const storage = new InMemoryStorageAdapter();
    await storage.createFact({
      workspaceId: WS,
      scope: "global",
      kind: "other",
      subject: "general",
      statement: OLD_SECRET,
      attribution: "user_stated",
      sensitivity: "confidential",
      embedding: [0.9, Math.sqrt(1 - 0.81)],
    } as never);
    const { ctx, embedded, prompted } = ctxFor(setup, storage);

    const res = await remember(
      ctx,
      { workspaceId: WS, kind: "fact", content: NEW_SECRET, sensitivity: "confidential" } as never,
      auth
    );

    expect(embedded.includes(NEW_SECRET)).toBe(expected.embed);
    const judged = prompted.some((p) => p.includes(NEW_SECRET) && p.includes(OLD_SECRET));
    expect(judged).toBe(expected.embed && expected.llm);
    expect(prompted.every((p) => !p.includes(NEW_SECRET))).toBe(!(expected.embed && expected.llm));
    // Kept without a vector when the embedder may not see it, never deferred.
    expect(res.embeddingDeferred).toBeUndefined();
    expect((await storage.getFact(res.id, WS))?.status).toBe("active");
  });

  it("recall rerank: a page holding confidential text goes to the judge only as allowed", async () => {
    const { ctx, prompted } = ctxFor(setup);
    const hits = [
      hit("a", "public note", 0.9, "internal"),
      hit("b", NEW_SECRET, 0.8, "confidential"),
      hit("c", "another note", 0.7, "public"),
    ];
    await maybeRerank(ctx, { text: "payroll", rerank: true, recurrenceThreshold: 0 }, hits);
    expect(prompted.some((p) => p.includes(NEW_SECRET))).toBe(expected.llm);
  });

  it("recall dedup: confidential hit text reaches the embedder only as allowed", async () => {
    const { ctx, embedded } = ctxFor(setup);
    const hits = [
      hit("a", "public note", 0.9, "internal"),
      hit("b", NEW_SECRET, 0.8, "confidential"),
      hit("c", "another note", 0.7, "public"),
    ];
    const out = await dedupByContent(ctx, hits);
    expect(embedded.includes(NEW_SECRET)).toBe(expected.embed);
    expect(out.map((h) => h.id).sort()).toEqual(["a", "b", "c"]);
  });
});

describe("non-sensitive text is not affected", () => {
  it("an internal fact is embedded and judged under none", async () => {
    const storage = new InMemoryStorageAdapter();
    await storage.createFact({
      workspaceId: WS,
      scope: "global",
      kind: "other",
      subject: "general",
      statement: "the staging cluster runs Postgres 16",
      attribution: "user_stated",
      embedding: [0.9, Math.sqrt(1 - 0.81)],
    } as never);
    const { ctx, embedded, prompted } = ctxFor({ policy: "none" }, storage);
    await remember(
      ctx,
      { workspaceId: WS, kind: "fact", content: "the staging cluster runs Postgres 17" } as never,
      auth
    );
    expect(embedded).toContain("the staging cluster runs Postgres 17");
    expect(prompted.some((p) => p.includes("Postgres 16"))).toBe(true);
  });
});

// Every kind carries a tier, not only facts: under `none` the text of a
// confidential decision is not embedded at write time either (the outbox
// worker and the re-embed sweep re-read the row's tier afterwards).
describe("other kinds under none", () => {
  it.each([
    ["none", "none", false],
    ["embed", "embed", true],
  ] as const)("a confidential decision under %s", async (_n, policy, sent) => {
    const { ctx, embedded } = ctxFor({ policy });
    await remember(
      ctx,
      {
        workspaceId: WS,
        kind: "decision",
        content: NEW_SECRET,
        subject: "payroll",
        sensitivity: "confidential",
      } as never,
      auth
    );
    expect(embedded.includes(NEW_SECRET)).toBe(sent);
  });

  it("a confidential entity queues no text job for the outbox to embed", async () => {
    const storage = new InMemoryStorageAdapter();
    const { ctx, embedded } = ctxFor({ policy: "none" }, storage);
    await remember(
      ctx,
      {
        workspaceId: WS,
        kind: "entity",
        content: NEW_SECRET,
        subject: "Larkspur payroll",
        sensitivity: "confidential",
      } as never,
      auth
    );
    expect(embedded).not.toContain(NEW_SECRET);
    const textJobs = storage.outbox.filter(
      (e) => e.eventType === "vector_upsert" && JSON.stringify(e.payload).includes("Acme Bank")
    );
    expect(textJobs).toHaveLength(0);
  });
});

describe("re-embed sweep (migrateWorkspace)", () => {
  it("never lists a confidential fact when the embedder may not get it", async () => {
    const { migrateWorkspace } = await import("../../resilience/embedMigration.js");
    const storage = new InMemoryStorageAdapter();
    const secret = await storage.createFact({
      workspaceId: WS,
      scope: "global",
      kind: "other",
      subject: "general",
      statement: NEW_SECRET,
      attribution: "user_stated",
      sensitivity: "confidential",
    } as never);
    const plain = await storage.createFact({
      workspaceId: WS,
      scope: "global",
      kind: "other",
      subject: "general",
      statement: "Larkspur ships on Thursdays",
      attribution: "user_stated",
    } as never);
    const seen: string[] = [];
    const embed = {
      model: "m2",
      async embed(texts: string[]) {
        seen.push(...texts);
        return texts.map(() => new Float32Array([1, 0]));
      },
    };
    await migrateWorkspace({
      storage,
      embed,
      workspaceId: WS,
      sensitiveTextToEmbedder: false,
    });
    expect(seen).toContain("Larkspur ships on Thursdays");
    expect(seen).not.toContain(NEW_SECRET);
    expect([secret.id, plain.id]).toHaveLength(2);
  });
});
