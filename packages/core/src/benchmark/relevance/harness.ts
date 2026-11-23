// BENCH-1 — recall relevance benchmark harness.
//
// Runs the REAL recall facade (`createCore(...).recall`, i.e. the hot → pointer
// → cold cascade the server calls) over the two labelled corpora of the
// 2026-10-17 evaluation, against InMemoryStorageAdapter plus a brute-force
// cosine vector index. Every vector comes from vectors.json — real bge-m3
// embeddings frozen once with generate-vectors.mjs — so the run needs no model,
// no network and no Docker, and is deterministic.
//
// What it can and cannot prove. It proves what the PIPELINE does with good
// vectors: ranking, floors, structural injection, warm-state drift. It cannot
// prove what another embedding model would score (Titan's cosines live on a
// different scale), nor anything about Postgres FTS — the in-memory lexical arm
// is a substring match, so lexical numbers here are not production's.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";
import type {
  AuthContext,
  CacheAdapter,
  EmbedAdapter,
  RecallHit,
  RecallQuery,
  RecallResponse,
  VectorAdapter,
  VectorSearchHit,
} from "@mnemo-ai/types";
import { createCore, type MnemoCore } from "../../cognitive/index.js";

// ─── Fixture ──────────────────────────────────────────────────────────────────

export interface BenchMemory {
  label: string;
  /** agentsim: the ground-truth key (duplicates share it); recall: same as label. */
  key?: string;
  kind: "fact" | "decision";
  project: string;
  text?: string;
  title?: string;
  body?: string;
  scopeRef?: string;
  topicKey?: string;
  /** "user": stored as a personal memory (scope_owner user:<id>). */
  owner?: "user";
  state: "active" | "superseded" | "forgotten";
  /** A wrong, re-saved value that stays active (agentsim's sloppy writes). */
  stale?: boolean;
}

export interface BenchQuery {
  id: string;
  text: string;
  relevant: string[];
  stale: string[];
  type?: string;
  project?: string;
  trap?: string;
}

export interface BenchCorpus {
  memories: BenchMemory[];
  queries: BenchQuery[];
}

export type CorpusName = "recall" | "agentsim";

const here = dirname(fileURLToPath(import.meta.url));

let cached: {
  corpora: Record<CorpusName, BenchCorpus>;
  vectors: Map<string, Float32Array>;
} | null = null;

export function loadFixture(): {
  corpora: Record<CorpusName, BenchCorpus>;
  vectors: Map<string, Float32Array>;
} {
  if (cached) return cached;
  const corpus = JSON.parse(readFileSync(join(here, "corpus.json"), "utf8")) as Record<
    CorpusName,
    BenchCorpus
  >;
  const raw = JSON.parse(readFileSync(join(here, "vectors.json"), "utf8")) as {
    vectors: Record<string, { s: number; q: string }>;
  };
  const vectors = new Map<string, Float32Array>();
  for (const [text, { s, q }] of Object.entries(raw.vectors)) {
    const bytes = Buffer.from(q, "base64url");
    const ints = new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    vectors.set(
      text,
      Float32Array.from(ints, (x) => x * s)
    );
  }
  cached = { corpora: { recall: corpus.recall, agentsim: corpus.agentsim }, vectors };
  return cached;
}

/** The text the write path embeds. Mirrors PRIMITIVE_TEXT_PROJECTION. */
export function memoryText(m: BenchMemory): string {
  if (m.kind === "decision") return [m.title ?? m.text, m.body].filter((s) => s).join(" ");
  return m.text!;
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

// ─── Workspace ────────────────────────────────────────────────────────────────

export const BENCH_WORKSPACE = "00000000-0000-4000-8000-00000000b001";
export const BENCH_USER = "00000000-0000-4000-8000-00000000b0b0";

export const BENCH_AUTH: AuthContext = {
  workspaceId: BENCH_WORKSPACE,
  actorId: "key:bench",
  actorType: "agent",
  userId: BENCH_USER,
  scopes: ["memory:read", "memory:write"],
} as AuthContext;

export interface BenchWorkspace {
  core: MnemoCore;
  storage: InMemoryStorageAdapter;
  corpus: BenchCorpus;
  idByLabel: Map<string, string>;
  memoryById: Map<string, BenchMemory>;
  vectors: Map<string, Float32Array>;
}

/** A sorted-set cache, enough for the hot tier (zincrby + zrangeByScore). */
function zsetCache(): CacheAdapter {
  const sets = new Map<string, Map<string, number>>();
  return {
    async zincrby(key: string, increment: number, member: string) {
      const set = sets.get(key) ?? new Map<string, number>();
      set.set(member, (set.get(member) ?? 0) + increment);
      sets.set(key, set);
      return set.get(member)!;
    },
    async zrangeByScore(key: string, min: number, max: number) {
      return [...(sets.get(key) ?? new Map<string, number>()).entries()]
        .filter(([, s]) => s >= min && s <= max)
        .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
        .map(([m]) => m);
    },
  } as unknown as CacheAdapter;
}

export async function buildWorkspace(name: CorpusName): Promise<BenchWorkspace> {
  const { corpora, vectors } = loadFixture();
  const corpus = corpora[name];
  const storage = new InMemoryStorageAdapter();
  const idByLabel = new Map<string, string>();
  const memoryById = new Map<string, BenchMemory>();
  const factVectors = new Map<string, Float32Array>();

  const vectorFor = (text: string): Float32Array => {
    const v =
      vectors.get(text) ?? vectors.get(text.replace(/\n\n/g, " ").replace(/\s+$/, "").trim());
    if (!v) throw new Error(`benchmark fixture has no vector for: ${JSON.stringify(text)}`);
    return v;
  };

  for (const m of corpus.memories) {
    const vec = vectorFor(memoryText(m));
    const owner = m.owner === "user" ? { scopeOwner: `user:${BENCH_USER}` } : {};
    let id: string;
    if (m.kind === "decision") {
      const d = await storage.createDecision({
        workspaceId: BENCH_WORKSPACE,
        kind: "decision",
        title: m.title ?? m.text!,
        body: m.body ?? "",
        ...(m.scopeRef ? { scopeRef: m.scopeRef } : {}),
        ...(m.topicKey ? { topicKey: m.topicKey } : {}),
        ...owner,
      });
      storage.setEmbedding(d.id, [...vec]);
      if (m.state !== "active") {
        await storage.archiveDecision(d.id, BENCH_WORKSPACE);
      }
      id = d.id;
    } else {
      const f = await storage.createFact({
        workspaceId: BENCH_WORKSPACE,
        scope: "global",
        statement: m.text!,
        subject: m.project,
        kind: "other",
        attribution: "user_stated",
        embedding: [...vec],
        ...(m.scopeRef ? { scopeRef: m.scopeRef } : {}),
        ...(m.topicKey ? { topicKey: m.topicKey } : {}),
        ...owner,
      });
      factVectors.set(f.id, vec);
      if (m.state !== "active") await storage.archiveFact(f.id, BENCH_WORKSPACE);
      id = f.id;
    }
    idByLabel.set(m.label, id);
    memoryById.set(id, m);
  }

  // pgvector over mnemo_fact: every row with a vector, closed ones included —
  // the cold pipeline, not the index, decides what is servable.
  const vector = {
    id: "bench-cosine",
    dimensions: 1024,
    async search(input: { vector: Float32Array; limit: number; minSimilarity?: number }) {
      const out: VectorSearchHit[] = [];
      for (const [id, vec] of factVectors) {
        const score = cosine(input.vector, vec);
        if (score >= (input.minSimilarity ?? 0)) out.push({ id, score, primitiveKind: "other" });
      }
      return out.sort((a, b) => b.score - a.score).slice(0, input.limit);
    },
    async upsert() {},
    async delete() {},
    async deleteByFilter() {
      return 0;
    },
    async healthCheck() {
      return { status: "ok" };
    },
    async close() {},
  } as unknown as VectorAdapter;

  const embed: EmbedAdapter = {
    id: "bench-frozen",
    model: "bge-m3",
    dimensions: 1024,
    semantic: true,
    async embedSingle(text: string) {
      return vectorFor(text);
    },
    async embed(texts: string[]) {
      return texts.map(vectorFor);
    },
  } as unknown as EmbedAdapter;

  const noop = () => undefined;
  const core = createCore({
    storage,
    vector,
    embed,
    cache: zsetCache(),
    outbox: { append: async () => undefined } as never,
    logger: { debug: noop, info: noop, warn: noop, error: noop } as never,
    telemetry: {
      startSpan: () => ({ setAttribute: noop, end: noop, recordException: noop }),
      counter: noop,
      histogram: noop,
      gauge: noop,
      shutdown: async () => undefined,
    } as never,
  });

  return { core, storage, corpus, idByLabel, memoryById, vectors };
}

// ─── Running and scoring ──────────────────────────────────────────────────────

export interface QueryOutcome {
  query: BenchQuery;
  labels: string[];
  hits: RecallHit[];
  response: RecallResponse;
}

export async function runQuery(
  ws: BenchWorkspace,
  query: BenchQuery,
  options: Partial<RecallQuery> = {}
): Promise<QueryOutcome> {
  const response = await ws.core.recall(
    { workspaceId: BENCH_WORKSPACE, text: query.text, limit: 10, ...options },
    BENCH_AUTH
  );
  const labels = response.hits.map((h) => ws.memoryById.get(h.id)?.label ?? `?${h.id}`);
  return { query, labels, hits: response.hits, response };
}

export async function runAll(
  ws: BenchWorkspace,
  options: Partial<RecallQuery> = {}
): Promise<QueryOutcome[]> {
  const out: QueryOutcome[] = [];
  for (const q of ws.corpus.queries) out.push(await runQuery(ws, q, options));
  return out;
}

/**
 * Production's Hebbian formation turned every result set recalled three times
 * into a co-recall hyperedge (RECALL-2: 396 of them in an hour). The in-memory
 * adapter has no co-occurrence counts, so a "warmed" workspace gets them here:
 * one hyperedge per served set, credited above the 0.5 expansion bar the way
 * recordHyperedgeCoActivation credits them in production.
 */
export async function seedCoRecallHyperedges(
  ws: BenchWorkspace,
  outcomes: QueryOutcome[]
): Promise<number> {
  let formed = 0;
  for (const o of outcomes) {
    const members = o.hits.filter((h) => h.primitive === "fact").map((h) => h.id);
    if (members.length < 3) continue;
    const he = await ws.storage.createHyperedge({
      workspaceId: BENCH_WORKSPACE,
      memberIds: members,
      label: "co-recalled",
    });
    await ws.storage.updateWorth(he.id, BENCH_WORKSPACE, "hyperedge", {
      success: 2,
      failure: 0,
      creditWeight: 1,
    });
    formed++;
  }
  return formed;
}

export interface Scores {
  positives: number;
  hit1: number;
  hit5: number;
  mrr: number;
  negatives: number;
  /** Negatives the response itself flags: no hits, or `nothingRelevant: true`. */
  negativesFlagged: number;
  /** Positives wrongly flagged `nothingRelevant: true`. */
  positivesFlagged: number;
  staleInTop10: number;
  decisionQueries: number;
  decisionHit5: number;
}

function isCorrect(ws: BenchWorkspace, q: BenchQuery, label: string): boolean {
  const m = ws.corpus.memories.find((x) => x.label === label);
  if (!m || m.stale) return false;
  return q.relevant.includes(m.key ?? m.label);
}

export function score(ws: BenchWorkspace, outcomes: QueryOutcome[]): Scores {
  const s: Scores = {
    positives: 0,
    hit1: 0,
    hit5: 0,
    mrr: 0,
    negatives: 0,
    negativesFlagged: 0,
    positivesFlagged: 0,
    staleInTop10: 0,
    decisionQueries: 0,
    decisionHit5: 0,
  };
  const kindOf = new Map(ws.corpus.memories.map((m) => [m.key ?? m.label, m.kind]));
  for (const o of outcomes) {
    const flagged =
      o.hits.length === 0 ||
      (o.response as RecallResponse & { nothingRelevant?: boolean }).nothingRelevant === true;
    const staleLabels = new Set(
      ws.corpus.memories
        .filter(
          (m) => o.query.stale.includes(m.key ?? m.label) && (m.state !== "active" || m.stale)
        )
        .map((m) => m.label)
    );
    if (o.labels.slice(0, 10).some((l) => staleLabels.has(l))) s.staleInTop10++;
    if (o.query.relevant.length === 0) {
      s.negatives++;
      if (flagged) s.negativesFlagged++;
      continue;
    }
    s.positives++;
    if (flagged) s.positivesFlagged++;
    const rank = o.labels.findIndex((l) => isCorrect(ws, o.query, l));
    if (rank === 0) s.hit1++;
    if (rank >= 0 && rank < 5) s.hit5++;
    if (rank >= 0) s.mrr += 1 / (rank + 1);
    if (o.query.relevant.some((k) => kindOf.get(k) === "decision")) {
      s.decisionQueries++;
      if (rank >= 0 && rank < 5) s.decisionHit5++;
    }
  }
  return s;
}

/** agentsim grading: a correct, non-stale memory in the top 3 (top 1). */
export function correctAt(ws: BenchWorkspace, outcomes: QueryOutcome[], k: number): number {
  return outcomes.filter((o) => {
    const rank = o.labels.findIndex((l) => isCorrect(ws, o.query, l));
    return rank >= 0 && rank < k;
  }).length;
}

/**
 * The ceiling: rank every live memory by raw cosine to the query, nothing
 * else — no activation, worth, graph or tiers. The same vectors the pipeline
 * gets, so the gap between this and `score()` is the pipeline's own doing.
 */
export function cosineCeiling(ws: BenchWorkspace): QueryOutcome[] {
  const live = ws.corpus.memories.filter((m) => m.state === "active");
  return ws.corpus.queries.map((q) => {
    const qv = ws.vectors.get(q.text)!;
    const ranked = live
      .map((m) => ({ m, s: cosine(qv, ws.vectors.get(memoryText(m))!) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, 10);
    return {
      query: q,
      labels: ranked.map((r) => r.m.label),
      hits: ranked.map(
        (r) => ({ id: ws.idByLabel.get(r.m.label)!, similarity: r.s }) as unknown as RecallHit
      ),
      response: { hits: [] } as unknown as RecallResponse,
    };
  });
}
