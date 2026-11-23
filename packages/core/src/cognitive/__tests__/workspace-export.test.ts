// flatten-legacy-dual-core PR9h (design.md D6.5) — pure-function proof for
// `exportWorkspace`/`exportFacts`/`exportDecisions`/`exportRelations`/
// `exportCitations`, reproducing legacy `factory.ts`'s `exportWorkspace`
// (four raw SQL `SELECT`s) snake_case row shape field-for-field, but composed
// from typed `StorageAdapter` reads. No DB: a small in-memory fake reproduces
// `queryFactsPage`'s cursor pagination and `listCitations`'s offset
// pagination, so these tests exercise the SAME pagination contract the real
// adapter implements (including their <=500-per-call clamps).
import { describe, it, expect } from "vitest";
import {
  exportWorkspace,
  exportFacts,
  exportDecisions,
  exportRelations,
  exportCitations,
  EXPORT_ROW_CAP,
} from "../export/workspace-export.js";
import type { ExportWorkspaceDeps } from "../export/workspace-export.js";
import type { MnemoFact, MnemoDecision, MnemoRelation, MnemoCitation } from "@mnemo-ai/types";

const WS = "ws1";

function fact(id: string, createdAt: Date): MnemoFact {
  return {
    id,
    workspaceId: WS,
    agentId: "agent-1",
    scope: "global",
    scopeRef: undefined,
    statement: `statement-${id}`,
    subject: `subject-${id}`,
    kind: "preference",
    confidence: 0.9,
    relevance: 0.5,
    hitCount: 1,
    lastRecalledAt: undefined,
    worthSuccess: 1,
    worthFailure: 0,
    worthAlpha: 2,
    worthBeta: 2,
    worth: 0.5,
    memoryType: "semantic",
    memoryStrength: 1,
    memoryStability: 1,
    lastStrengthUpdate: undefined,
    attribution: "user_stated",
    attributedTo: "user",
    sourceMessageIds: [],
    linkedMemoryIds: [],
    sessionId: undefined,
    extractionSource: undefined,
    topicKey: undefined,
    revisionCount: 0,
    protocolVersion: "v1",
    entityId: undefined,
    episodeId: undefined,
    status: "active",
    pinned: false,
    canonical: false,
    sensitivity: "internal",
    mergedIntoId: undefined,
    validFrom: createdAt,
    validTo: undefined,
    embedding: undefined,
    embeddingModel: undefined,
    embeddingStale: false,
    createdAt,
    updatedAt: createdAt,
    metadata: {},
  };
}

function decision(id: string): MnemoDecision {
  return {
    id,
    workspaceId: WS,
    agentId: "agent-1",
    conversationId: undefined,
    kind: "decision",
    title: `title-${id}`,
    body: `body-${id}`,
    topicKey: undefined,
    revisionCount: 0,
    normalizedHash: "hash",
    status: "active",
    supersededById: undefined,
    decidedByUserId: undefined,
    confidence: undefined,
    sensitivity: "internal",
    embedding: undefined,
    embeddingModel: undefined,
    embeddingStale: false,
    validFrom: new Date(0),
    validTo: undefined,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    metadata: {},
  };
}

function relation(id: string): MnemoRelation {
  return {
    id,
    workspaceId: WS,
    sourceId: "src",
    sourceType: "fact",
    targetId: "tgt",
    targetType: "fact",
    verb: "related",
    weight: 0.5,
    coRecallCount: 0,
    directionality: 0,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    validFrom: new Date(0),
    validTo: null,
    judgmentStatus: "pending",
    reason: null,
    evidence: null,
    confidence: null,
    markedByUserId: null,
    markedByKind: "system",
    markedByModel: null,
    markedByPromptVersion: null,
    provenance: null,
    conversationId: null,
    supersededByRelationId: null,
  };
}

function citation(id: string): MnemoCitation {
  return {
    id,
    workspaceId: WS,
    memoryKind: "fact",
    memoryId: "fact-1",
    sourceKind: "message",
    sourceId: "msg-1",
    extractorModel: null,
    extractorPromptVersion: null,
    judgeModel: null,
    judgeRelationId: null,
    evidenceExcerpt: null,
    createdAt: new Date(0),
  };
}

describe("exportFacts", () => {
  it("maps a fact to the exact legacy snake_case row shape", async () => {
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    const deps: ExportWorkspaceDeps = {
      storage: {
        queryFactsPage: async () => ({
          items: [fact("f1", createdAt)],
          nextCursor: null,
          total: 1,
        }),
      } as unknown as ExportWorkspaceDeps["storage"],
    };
    const rows = await exportFacts(deps, WS);
    expect(rows).toEqual([
      {
        id: "f1",
        agent_id: "agent-1",
        scope: "global",
        scope_ref: null,
        kind: "preference",
        subject: "subject-f1",
        statement: "statement-f1",
        confidence: 0.9,
        pinned: false,
        relevance: 0.5,
        hit_count: 1,
        last_recalled_at: null,
        source_message_ids: [],
        attributed_to: "user",
        linked_memory_ids: [],
        metadata: {},
        status: "active",
        merged_into_id: null,
        valid_from: createdAt,
        valid_to: null,
        created_at: createdAt,
        updated_at: createdAt,
      },
    ]);
  });

  it("walks queryFactsPage's cursor past its per-call clamp up to EXPORT_ROW_CAP", async () => {
    const calls: unknown[] = [];
    const page1 = [fact("f1", new Date(1)), fact("f2", new Date(2))];
    const page2 = [fact("f3", new Date(3))];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const queryFactsPage = async (filter: any) => {
      calls.push(filter);
      if (!filter.cursor) return { items: page1, nextCursor: "cursor-1", total: 3 };
      return { items: page2, nextCursor: null, total: 3 };
    };
    const deps: ExportWorkspaceDeps = {
      storage: { queryFactsPage } as unknown as ExportWorkspaceDeps["storage"],
    };
    const rows = await exportFacts(deps, WS);
    expect(rows.map((r) => r["id"])).toEqual(["f1", "f2", "f3"]);
    expect(calls).toHaveLength(2);
    expect((calls[1] as { cursor: string }).cursor).toBe("cursor-1");
  });

  it("stops at an empty page without an infinite loop", async () => {
    const deps: ExportWorkspaceDeps = {
      storage: {
        queryFactsPage: async () => ({ items: [], nextCursor: null, total: 0 }),
      } as unknown as ExportWorkspaceDeps["storage"],
    };
    const rows = await exportFacts(deps, WS);
    expect(rows).toEqual([]);
  });
});

describe("exportDecisions", () => {
  it("maps a decision to the exact legacy snake_case row shape and requests EXPORT_ROW_CAP in one call", async () => {
    let capturedLimit: number | undefined;
    const deps: ExportWorkspaceDeps = {
      storage: {
        queryDecisions: async (filter: { limit?: number }) => {
          capturedLimit = filter.limit;
          return {
            items: [decision("d1")],
            total: 1,
            offset: 0,
            limit: filter.limit ?? 0,
            hasMore: false,
          };
        },
      } as unknown as ExportWorkspaceDeps["storage"],
    };
    const rows = await exportDecisions(deps, WS);
    expect(capturedLimit).toBe(EXPORT_ROW_CAP);
    expect(rows).toEqual([
      {
        id: "d1",
        agent_id: "agent-1",
        conversation_id: null,
        kind: "decision",
        title: "title-d1",
        body: "body-d1",
        topic_key: null,
        revision_count: 0,
        normalized_hash: "hash",
        decided_by_user_id: null,
        status: "active",
        superseded_by_id: null,
        metadata: {},
        valid_from: new Date(0),
        valid_to: null,
        created_at: new Date(0),
        updated_at: new Date(0),
      },
    ]);
  });
});

describe("exportRelations", () => {
  it("maps a relation to the exact legacy snake_case row shape (sourceType/targetType/verb renamed)", async () => {
    const deps: ExportWorkspaceDeps = {
      storage: {
        getRelations: async () => [relation("r1")],
      } as unknown as ExportWorkspaceDeps["storage"],
    };
    const rows = await exportRelations(deps, WS);
    expect(rows).toEqual([
      {
        id: "r1",
        source_kind: "fact",
        source_id: "src",
        target_kind: "fact",
        target_id: "tgt",
        relation: "related",
        judgment_status: "pending",
        reason: null,
        evidence: null,
        confidence: null,
        marked_by_user_id: null,
        marked_by_kind: "system",
        marked_by_model: null,
        marked_by_prompt_version: null,
        conversation_id: null,
        superseded_by_relation_id: null,
        valid_from: new Date(0),
        valid_to: null,
        created_at: new Date(0),
        updated_at: new Date(0),
      },
    ]);
  });
});

describe("exportCitations", () => {
  it("maps a citation to the exact legacy snake_case row shape", async () => {
    const deps: ExportWorkspaceDeps = {
      storage: {
        listCitations: async () => [citation("c1")],
      } as unknown as ExportWorkspaceDeps["storage"],
    };
    const rows = await exportCitations(deps, WS);
    expect(rows).toEqual([
      {
        id: "c1",
        memory_kind: "fact",
        memory_id: "fact-1",
        source_kind: "message",
        source_id: "msg-1",
        extractor_model: null,
        extractor_prompt_version: null,
        judge_model: null,
        judge_relation_id: null,
        evidence_excerpt: null,
        created_at: new Date(0),
      },
    ]);
  });

  it("stops after one call when the page is shorter than the requested limit", async () => {
    const calls: unknown[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const listCitations = async (filter: any) => {
      calls.push(filter);
      return [citation("c1"), citation("c2")]; // 2 < the requested limit (500)
    };
    const deps: ExportWorkspaceDeps = {
      storage: { listCitations } as unknown as ExportWorkspaceDeps["storage"],
    };
    const rows = await exportCitations(deps, WS);
    expect(rows.map((r) => r["id"])).toEqual(["c1", "c2"]);
    expect(calls).toHaveLength(1);
  });

  it("keeps paging via offset when a full-size page is returned", async () => {
    const calls: unknown[] = [];
    const fullPage = Array.from({ length: 500 }, (_, i) => citation(`c${i}`));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const listCitations = async (filter: any) => {
      calls.push(filter);
      if (filter.offset === 0) return fullPage; // exactly the requested limit => keep paging
      return [citation("last")]; // short final page => exhausted
    };
    const deps: ExportWorkspaceDeps = {
      storage: { listCitations } as unknown as ExportWorkspaceDeps["storage"],
    };
    const rows = await exportCitations(deps, WS);
    expect(rows).toHaveLength(501);
    expect(calls).toHaveLength(2);
    expect((calls[1] as { offset: number }).offset).toBe(500);
  });
});

describe("exportWorkspace", () => {
  it("composes all 4 resources into the legacy 4-key shape", async () => {
    const deps: ExportWorkspaceDeps = {
      storage: {
        queryFactsPage: async () => ({
          items: [fact("f1", new Date(0))],
          nextCursor: null,
          total: 1,
        }),
        queryDecisions: async () => ({
          items: [decision("d1")],
          total: 1,
          offset: 0,
          limit: 1,
          hasMore: false,
        }),
        getRelations: async () => [relation("r1")],
        listCitations: async () => [citation("c1")],
      } as unknown as ExportWorkspaceDeps["storage"],
    };
    const result = await exportWorkspace(deps, WS);
    expect(Object.keys(result).sort()).toEqual(["citations", "decisions", "facts", "relations"]);
    expect(result.facts).toHaveLength(1);
    expect(result.decisions).toHaveLength(1);
    expect(result.relations).toHaveLength(1);
    expect(result.citations).toHaveLength(1);
  });
});
