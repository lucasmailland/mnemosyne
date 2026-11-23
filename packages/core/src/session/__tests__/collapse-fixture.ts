/**
 * Shared double for the collapse-integrity tests (LIFECYCLE-3/4/5/7/9/13).
 *
 * The storage half behaves like the Postgres adapter where these findings live:
 *   - an active fact's `topicKey` is unique (`idx_fact_topic_active_unique`, exact
 *     match) and a decision's is unique once lower/btrim-normalised
 *     (`uniq_mnemo_decision_topic`) — a colliding INSERT throws, as the index does;
 *   - so is an active fact's statement within its scope, scopeRef and subject
 *     (`uniq_mnemo_fact_dedup`), for an insert and for a merge's successor;
 *   - `mergeFactByTopicKey` is a bitemporal supersede: the predecessor is closed
 *     and a successor with a new id inherits its `sessionId` (FactRepository P76).
 *
 * The LLM half replays a queue of replies, so a test can script a malformed first
 * answer followed by a valid one. The embedder is deterministic and the vector
 * search answers with a per-text similarity, which is how a test pins the
 * surprise gate's PE for one specific statement.
 */
import { vi, type Mock } from "vitest";
import type { AuthContext } from "@mnemo-ai/types";
import type { CoreContext } from "../../cognitive/context.js";

export const auth = {
  actorId: "system:test",
  actorType: "system",
  workspaceId: "ws",
  scopes: [],
} as unknown as AuthContext;

export interface FakeFact {
  id: string;
  statement: string;
  topicKey?: string;
  status: "active" | "forgotten";
  sessionId?: string;
  episodeId?: string;
  kind?: string;
  scope?: string;
  scopeRef?: string;
  subject?: string;
  confidence?: number;
}

export interface FakeDecision {
  id: string;
  title: string;
  body: string;
  kind: string;
  topicKey?: string;
  status: "active" | "superseded";
}

export interface FakeStrategy {
  id: string;
  trigger: string;
  action: string;
}

export interface HarnessOptions {
  /** Raw LLM replies, consumed in order; the last one repeats. Objects are JSON-encoded. */
  replies: Array<string | Record<string, unknown>>;
  seedFacts?: Array<Omit<FakeFact, "id" | "status"> & { id?: string }>;
  seedDecisions?: Array<Omit<FakeDecision, "id" | "status"> & { id?: string }>;
  seedStrategies?: Array<Omit<FakeStrategy, "id">>;
  /** Cosine the vector search reports for a statement (default 0 → PE 1, always novel). */
  similarity?: (text: string) => number;
  /** Id the vector search reports as that nearest neighbour (default "neighbour"). */
  neighbourId?: string;
  turns?: number;
  sessionStatus?: string;
  surpriseThreshold?: number;
  /**
   * Give the double a transactional `commitSessionCollapse`: a session already
   * `collapsed` is refused, and a throw from `apply` restores every map, the way
   * a rolled-back Postgres transaction would.
   */
  atomic?: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = Mock<(...args: any[]) => any>;

export type FakeStorage = Record<
  | "getSession"
  | "getFact"
  | "listTurns"
  | "queryFacts"
  | "createFact"
  | "findLiveFactByStatement"
  | "mergeFactByTopicKey"
  | "createDecision"
  | "mergeDecisionByTopicKey"
  | "createStrategy"
  | "queryStrategies"
  | "createRelation"
  | "createEpisode"
  | "linkSessionFactsToEpisode"
  | "updateSessionSummary"
  | "closeSession"
  | "archiveSession"
  | "recordCollapseFailure"
  | "appendOutbox",
  AnyMock
> & { commitSessionCollapse?: AnyMock };

export interface Harness {
  ctx: CoreContext;
  storage: FakeStorage;
  generate: AnyMock;
  warn: AnyMock;
  facts: Map<string, FakeFact>;
  decisions: Map<string, FakeDecision>;
  strategies: FakeStrategy[];
  episodes: Array<Record<string, unknown>>;
  relations: Array<Record<string, unknown>>;
  outbox: Array<Record<string, unknown>>;
  session: { id: string; status: string; metadata: Record<string, unknown> };
  activeFacts: () => FakeFact[];
  activeDecisions: () => FakeDecision[];
}

function normKey(k: string): string {
  return k.trim().toLowerCase();
}

export function makeHarness(opts: HarnessOptions): Harness {
  let seq = 0;
  const nextId = (p: string) => `${p}_${++seq}`;

  const facts = new Map<string, FakeFact>();
  const decisions = new Map<string, FakeDecision>();
  const strategies: FakeStrategy[] = [];
  const episodes: Array<Record<string, unknown>> = [];
  const relations: Array<Record<string, unknown>> = [];
  const outbox: Array<Record<string, unknown>> = [];
  const session = {
    id: "s1",
    workspaceId: "ws",
    agentId: "agent-1",
    status: opts.sessionStatus ?? "active",
    turnCount: opts.turns ?? 6,
    tokenCount: 100,
    openedAt: new Date(0),
    metadata: {} as Record<string, unknown>,
  };

  for (const f of opts.seedFacts ?? []) {
    const id = f.id ?? nextId("seed_fact");
    facts.set(id, { ...f, id, status: "active" });
  }
  for (const st of opts.seedStrategies ?? []) strategies.push({ ...st, id: nextId("seed_strat") });
  for (const d of opts.seedDecisions ?? []) {
    const id = d.id ?? nextId("seed_dec");
    decisions.set(id, { ...d, id, status: "active" });
  }

  const activeFactByKey = (key: string) =>
    [...facts.values()].find((f) => f.status === "active" && f.topicKey === key);
  // `uniq_mnemo_fact_dedup`: (scope, COALESCE(scope_ref, ''), subject, md5(statement)) over live rows.
  const dedupKey = (f: {
    scope?: string;
    scopeRef?: string;
    subject?: string;
    statement: string;
  }) =>
    JSON.stringify([f.scope ?? "global", f.scopeRef ?? "", f.subject ?? "general", f.statement]);
  const liveDuplicate = (f: Parameters<typeof dedupKey>[0]) =>
    [...facts.values()].find((x) => x.status === "active" && dedupKey(x) === dedupKey(f));
  const dedupViolation = () =>
    new Error('duplicate key value violates unique constraint "uniq_mnemo_fact_dedup"');
  const activeDecisionByKey = (key: string) =>
    [...decisions.values()].find(
      (d) =>
        d.status === "active" && d.topicKey !== undefined && normKey(d.topicKey) === normKey(key)
    );

  const storage: FakeStorage = {
    getSession: vi.fn(async () => ({ ...session })),
    getFact: vi.fn(async (id: string) => {
      const f = facts.get(id);
      return f ? { ...f } : null;
    }),
    listTurns: vi.fn(async () =>
      Array.from({ length: opts.turns ?? 6 }, (_, i) => ({
        id: `t${i}`,
        workspaceId: "ws",
        sessionId: "s1",
        turnIndex: i,
        role: i % 2 === 0 ? "user" : "assistant",
        content: `turn ${i} about the orders-api rate limit`,
        createdAt: new Date(0),
      }))
    ),
    queryFacts: vi.fn(
      async (filter: { topicKey?: string; status?: string; sessionId?: string }) => {
        const items = [...facts.values()].filter(
          (f) =>
            (filter.topicKey === undefined || f.topicKey === filter.topicKey) &&
            (filter.sessionId === undefined || f.sessionId === filter.sessionId) &&
            (filter.status === undefined || f.status === filter.status)
        );
        return { items, total: items.length };
      }
    ),
    createFact: vi.fn(async (input: Record<string, unknown>) => {
      const key = input.topicKey as string | undefined;
      if (key && activeFactByKey(key)) {
        throw new Error(
          'duplicate key value violates unique constraint "idx_fact_topic_active_unique"'
        );
      }
      const fact: FakeFact = {
        id: nextId("fact"),
        statement: input.statement as string,
        ...(key ? { topicKey: key } : {}),
        status: "active",
        sessionId: input.sessionId as string | undefined,
        kind: input.kind as string | undefined,
        scope: input.scope as string | undefined,
        ...(input.scopeRef ? { scopeRef: input.scopeRef as string } : {}),
        subject: input.subject as string | undefined,
        confidence: input.confidence as number | undefined,
      };
      if (liveDuplicate(fact)) throw dedupViolation();
      facts.set(fact.id, fact);
      return { ...fact };
    }),
    findLiveFactByStatement: vi.fn(
      async (input: { scope: string; scopeRef?: string; subject: string; statement: string }) => {
        const f = liveDuplicate(input);
        return f ? { ...f } : null;
      }
    ),
    mergeFactByTopicKey: vi.fn(
      async (input: { workspaceId: string; topicKey: string; statement: string }) => {
        const source = activeFactByKey(input.topicKey);
        if (!source) return null;
        const successor: FakeFact = {
          ...source,
          id: nextId("fact"),
          statement: input.statement,
          status: "active",
        };
        // The successor INSERT runs in the merge's own savepoint: a collision
        // leaves the predecessor untouched.
        const clash = liveDuplicate(successor);
        if (clash && clash.id !== source.id) throw dedupViolation();
        source.status = "forgotten";
        facts.set(successor.id, successor);
        return { ...successor };
      }
    ),
    createDecision: vi.fn(async (input: Record<string, unknown>) => {
      const key = input.topicKey as string | undefined;
      if (key && activeDecisionByKey(key)) {
        throw new Error(
          'duplicate key value violates unique constraint "uniq_mnemo_decision_topic"'
        );
      }
      const d: FakeDecision = {
        id: nextId("dec"),
        title: input.title as string,
        body: input.body as string,
        kind: input.kind as string,
        ...(key ? { topicKey: key } : {}),
        status: "active",
      };
      decisions.set(d.id, d);
      return { ...d };
    }),
    mergeDecisionByTopicKey: vi.fn(
      async (input: { topicKey: string; title: string; body: string; kind: string }) => {
        const source = activeDecisionByKey(input.topicKey);
        if (!source) return null;
        Object.assign(source, { title: input.title, body: input.body, kind: input.kind });
        return { ...source };
      }
    ),
    createStrategy: vi.fn(async (input: Record<string, unknown>) => {
      const s = {
        id: nextId("strat"),
        trigger: input.trigger as string,
        action: input.action as string,
      };
      strategies.push(s);
      return s;
    }),
    queryStrategies: vi.fn(async () => ({
      items: strategies.map((st) => ({ ...st, status: "active" })),
      total: strategies.length,
    })),
    createRelation: vi.fn(async (input: Record<string, unknown>) => {
      relations.push(input);
      return { id: nextId("rel") };
    }),
    createEpisode: vi.fn(async (input: Record<string, unknown>) => {
      const ep = { id: nextId("ep"), ...input };
      episodes.push(ep);
      return ep;
    }),
    linkSessionFactsToEpisode: vi.fn(async (_ws: string, sessionId: string, episodeId: string) => {
      let linked = 0;
      for (const f of facts.values()) {
        if (f.sessionId === sessionId && f.episodeId === undefined) {
          f.episodeId = episodeId;
          linked++;
        }
      }
      return linked;
    }),
    updateSessionSummary: vi.fn(async (args: { summary: Record<string, unknown> }) => {
      session.metadata = { ...session.metadata, lastSummary: args.summary };
    }),
    closeSession: vi.fn(async () => {
      session.status = "collapsed";
    }),
    archiveSession: vi.fn(async () => {
      session.status = "archived";
    }),
    recordCollapseFailure: vi.fn(async () => {}),
    appendOutbox: vi.fn(async (entry: Record<string, unknown>) => {
      outbox.push(entry);
    }),
  };

  if (opts.atomic) {
    // The row lock: one commit at a time, like SELECT … FOR UPDATE.
    let lock: Promise<unknown> = Promise.resolve();
    const commit = async (
      input: { terminalStatus?: string },
      apply: (s: unknown) => Promise<unknown>
    ) => {
      if (session.status === "collapsed") return { committed: false, status: session.status };
      const before = {
        facts: [...facts.entries()].map(([k, v]) => [k, { ...v }] as const),
        decisions: [...decisions.entries()].map(([k, v]) => [k, { ...v }] as const),
        strategies: [...strategies],
        episodes: [...episodes],
        relations: [...relations],
        outbox: [...outbox],
        metadata: { ...session.metadata },
      };
      try {
        const value = await apply(storage);
        session.status = input.terminalStatus ?? "collapsed";
        return { committed: true, value };
      } catch (err) {
        facts.clear();
        for (const [k, v] of before.facts) facts.set(k, v);
        decisions.clear();
        for (const [k, v] of before.decisions) decisions.set(k, v);
        strategies.splice(0, strategies.length, ...before.strategies);
        episodes.splice(0, episodes.length, ...before.episodes);
        relations.splice(0, relations.length, ...before.relations);
        outbox.splice(0, outbox.length, ...before.outbox);
        session.metadata = before.metadata;
        throw err;
      }
    };
    storage.commitSessionCollapse = vi.fn(
      (input: { terminalStatus?: string }, apply: (s: unknown) => Promise<unknown>) => {
        const run = lock.then(() => commit(input, apply));
        lock = run.catch(() => undefined);
        return run;
      }
    );
  }

  const replies = opts.replies.map((r) => (typeof r === "string" ? r : JSON.stringify(r)));
  let replyIndex = 0;
  const generate: AnyMock = vi.fn(async () => {
    const content = replies[Math.min(replyIndex, replies.length - 1)]!;
    replyIndex++;
    return {
      content,
      tokensUsed: { input: 10, output: 10 },
      model: "fake",
      finishReason: "stop" as const,
    };
  });

  let lastEmbedded = "";
  const similarity = opts.similarity ?? (() => 0);
  const warn: AnyMock = vi.fn();
  const ctx = {
    config: { surpriseThreshold: opts.surpriseThreshold ?? 0.15, maxHotTierSize: 1000 },
    logger: {
      debug() {},
      info() {},
      warn,
      error() {},
      child() {
        return this;
      },
    },
    embed: {
      id: "fake-embed",
      embed: async (xs: string[]) => {
        lastEmbedded = xs[xs.length - 1] ?? "";
        // Identical unit vectors: the RecMem gate sees perfect recurrence.
        return xs.map(() => [1, 0, 0]);
      },
      embedSingle: async () => [1, 0, 0],
    },
    vector: {
      search: async () => {
        const score = similarity(lastEmbedded);
        return score > 0 ? [{ id: opts.neighbourId ?? "neighbour", score }] : [];
      },
    },
    llm: { id: "fake-llm", generate },
    cache: null,
    outbox: { append: async () => {} },
    storage,
  } as unknown as CoreContext;

  const activeFacts = () => [...facts.values()].filter((f) => f.status === "active");
  const activeDecisions = () => [...decisions.values()].filter((d) => d.status === "active");

  return {
    ctx,
    storage,
    generate,
    warn,
    facts,
    decisions,
    strategies,
    episodes,
    relations,
    outbox,
    session,
    activeFacts,
    activeDecisions,
  };
}

/** A valid extraction reply with sensible defaults. */
export function reply(
  parts: {
    facts?: Array<Record<string, unknown>>;
    decisions?: Array<Record<string, unknown>>;
    strategies?: Array<Record<string, unknown>>;
  } & Record<string, unknown>
): Record<string, unknown> {
  return {
    goal: "tune the orders-api",
    outcome: "resolved",
    facts: [],
    decisions: [],
    strategies: [],
    ...parts,
  };
}
