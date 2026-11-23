// flatten-legacy-dual-core PR9h (design.md D6.5 "Export — no new port method
// at all"). Pure-core reimplementation of legacy `packages/core/src/
// factory.ts`'s `exportWorkspace`: same four resources (facts/decisions/
// relations/citations), same 100k-row-per-resource cap, same snake_case wire
// row shape (`toLegacyFactExportRow`/`toLegacyDecisionExportRow`/
// `toLegacyRelationExportRow`/`toLegacyCitationExportRow` — collectively the
// `toLegacyExportRow()` projection design.md D6.5 refers to) — but composed
// from the typed `StorageAdapter` reads D6.2 (`queryFactsPage`)/D6.4
// (`getRelations` widening)/D6.5 (`listCitations`) already added, instead of
// 4 raw SQL `SELECT`s against the legacy `db/schema/*` Drizzle tables.
//
// Cardinal hexagonal-purity rule (CLAUDE.md, enforced by v3-purity.test.ts):
// this file carries zero infrastructure package references — all I/O flows
// through the injected port methods below, never a direct database client.
//
// Known, disclosed behavior differences from legacy (flatten-legacy-dual-core
// PR9h apply-progress.md has the full writeup — none are regressions the
// Tier A parity test's loose `export.schema.json` contract or the response
// key-set assertions can observe):
//   1. No single-transaction consistent snapshot across the 4 resources —
//      each resource is read via its own `StorageAdapter` call (its own
//      adapter-side transaction), the same tradeoff `GET /export/jsonl`'s
//      other 11 entity types already accepted before this PR.
//   2. Row ordering is per-method, not uniformly `created_at ASC` like
//      legacy's raw SQL: `exportFacts` explicitly requests
//      `sortBy: 'created_at', order: 'asc'` (matches legacy exactly);
//      `getRelations`/`listCitations` return a fixed `created_at DESC`
//      (their pre-existing, unconfigurable order); `queryDecisions` has no
//      `ORDER BY` at all (raw Postgres return order). No export test pins
//      array order — only per-row key/value shape — so this is informational.
//   3. `queryFactsPage`/`listCitations` clamp to <=500 rows per adapter call
//      (`FactRepository.ts`/`CitationRepository.ts`); `exportFacts`/
//      `exportCitations` page past that clamp (cursor walk / offset walk
//      respectively) up to `EXPORT_ROW_CAP`. `listCitations`'s `offset`
//      field is a PR9h-added, additive `CitationFilter` widening — no new
//      port method, same class as PR9c's `sourceIds`/PR9f's `targetIds`.

import type {
  StorageAdapter,
  MnemoFact,
  MnemoDecision,
  MnemoRelation,
  MnemoCitation,
  Sensitivity,
} from "@mnemo-ai/types";

export interface ExportWorkspaceDeps {
  storage: Pick<
    StorageAdapter,
    "queryFactsPage" | "queryDecisions" | "getRelations" | "listCitations"
  >;
}

/** Matches legacy `factory.ts`'s `exportWorkspace`'s `ROW_CAP` — one shared cap across all 4 resources. */
export const EXPORT_ROW_CAP = 100_000;

/** `queryFactsPage`'s internal per-call clamp (`FactRepository.ts`). */
const FACTS_PAGE_SIZE = 500;
/** `listCitations`'s internal per-call clamp (`CitationRepository.ts`). */
const CITATIONS_PAGE_SIZE = 500;

export interface LegacyWorkspaceExport {
  facts: Array<Record<string, unknown>>;
  decisions: Array<Record<string, unknown>>;
  relations: Array<Record<string, unknown>>;
  citations: Array<Record<string, unknown>>;
}

// ─── toLegacyExportRow() — snake_case projections pinned by ────────────────
// ─── __tests__/parity/export.parity.test.ts (design.md D6.5)         ───────

/** Mirrors `factory.ts`'s `exportWorkspace` facts `SELECT` column list verbatim. */
function toLegacyFactExportRow(row: MnemoFact): Record<string, unknown> {
  return {
    id: row.id,
    agent_id: row.agentId ?? null,
    scope: row.scope,
    scope_ref: row.scopeRef ?? null,
    kind: row.kind,
    subject: row.subject,
    statement: row.statement,
    confidence: row.confidence,
    pinned: row.pinned,
    relevance: row.relevance,
    hit_count: row.hitCount,
    last_recalled_at: row.lastRecalledAt ?? null,
    source_message_ids: row.sourceMessageIds,
    attributed_to: row.attributedTo ?? null,
    linked_memory_ids: row.linkedMemoryIds,
    metadata: row.metadata,
    status: row.status,
    merged_into_id: row.mergedIntoId ?? null,
    valid_from: row.validFrom,
    valid_to: row.validTo ?? null,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

/** Mirrors `factory.ts`'s `exportWorkspace` decisions `SELECT` column list verbatim. */
function toLegacyDecisionExportRow(row: MnemoDecision): Record<string, unknown> {
  return {
    id: row.id,
    agent_id: row.agentId ?? null,
    conversation_id: row.conversationId ?? null,
    kind: row.kind,
    title: row.title,
    body: row.body,
    topic_key: row.topicKey ?? null,
    revision_count: row.revisionCount,
    normalized_hash: row.normalizedHash,
    decided_by_user_id: row.decidedByUserId ?? null,
    status: row.status,
    superseded_by_id: row.supersededById ?? null,
    metadata: row.metadata,
    valid_from: row.validFrom,
    valid_to: row.validTo ?? null,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

/** Mirrors `factory.ts`'s `exportWorkspace` relations `SELECT` column list verbatim. */
function toLegacyRelationExportRow(row: MnemoRelation): Record<string, unknown> {
  return {
    id: row.id,
    source_kind: row.sourceType,
    source_id: row.sourceId,
    target_kind: row.targetType,
    target_id: row.targetId,
    relation: row.verb,
    judgment_status: row.judgmentStatus,
    reason: row.reason,
    evidence: row.evidence,
    confidence: row.confidence,
    marked_by_user_id: row.markedByUserId,
    marked_by_kind: row.markedByKind,
    marked_by_model: row.markedByModel,
    marked_by_prompt_version: row.markedByPromptVersion,
    conversation_id: row.conversationId,
    superseded_by_relation_id: row.supersededByRelationId,
    valid_from: row.validFrom,
    valid_to: row.validTo,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

/** Mirrors `factory.ts`'s `exportWorkspace` citations `SELECT` column list verbatim. */
function toLegacyCitationExportRow(row: MnemoCitation): Record<string, unknown> {
  return {
    id: row.id,
    memory_kind: row.memoryKind,
    memory_id: row.memoryId,
    source_kind: row.sourceKind,
    source_id: row.sourceId,
    extractor_model: row.extractorModel,
    extractor_prompt_version: row.extractorPromptVersion,
    judge_model: row.judgeModel,
    judge_relation_id: row.judgeRelationId,
    evidence_excerpt: row.evidenceExcerpt,
    created_at: row.createdAt,
  };
}

// ─── Per-resource projections (also used standalone by GET /export/jsonl, ──
// ─── which only needs relations+citations — facts/decisions come from its  ─
// ─── own per-type `deps.storage.queryFacts`/`queryDecisions` calls)       ──

/** Walks `queryFactsPage`'s cursor past its 500/call clamp up to `EXPORT_ROW_CAP`. */
export async function exportFacts(
  deps: ExportWorkspaceDeps,
  workspaceId: string,
  /** Facts above it are left out: reads decrypt confidential+ text (SECURITY.md §7). */
  maxSensitivity?: Sensitivity
): Promise<Array<Record<string, unknown>>> {
  const rows: MnemoFact[] = [];
  let cursor: string | undefined;
  while (rows.length < EXPORT_ROW_CAP) {
    const remaining = EXPORT_ROW_CAP - rows.length;
    const page = await deps.storage.queryFactsPage({
      workspaceId,
      status: "all",
      sortBy: "created_at",
      order: "asc",
      limit: Math.min(FACTS_PAGE_SIZE, remaining),
      ...(cursor ? { cursor } : {}),
      ...(maxSensitivity ? { maxSensitivity } : {}),
    });
    if (page.items.length === 0) break;
    rows.push(...page.items);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return rows.slice(0, EXPORT_ROW_CAP).map(toLegacyFactExportRow);
}

/** `queryDecisions` has no internal clamp (unlike facts/citations) — one call suffices. */
export async function exportDecisions(
  deps: ExportWorkspaceDeps,
  workspaceId: string
): Promise<Array<Record<string, unknown>>> {
  const page = await deps.storage.queryDecisions({ workspaceId, limit: EXPORT_ROW_CAP });
  return page.items.slice(0, EXPORT_ROW_CAP).map(toLegacyDecisionExportRow);
}

/** `getRelations` has no internal clamp (unlike facts/citations) — one call suffices. */
export async function exportRelations(
  deps: ExportWorkspaceDeps,
  workspaceId: string
): Promise<Array<Record<string, unknown>>> {
  const rows = await deps.storage.getRelations({
    workspaceId,
    // An export is a backup: closed relations are history it keeps.
    openOnly: false,
    limit: EXPORT_ROW_CAP,
  });
  return rows.slice(0, EXPORT_ROW_CAP).map(toLegacyRelationExportRow);
}

/** Walks `listCitations`'s PR9h-added `offset` field past its 500/call clamp up to `EXPORT_ROW_CAP`. */
export async function exportCitations(
  deps: ExportWorkspaceDeps,
  workspaceId: string
): Promise<Array<Record<string, unknown>>> {
  const rows: MnemoCitation[] = [];
  let offset = 0;
  while (rows.length < EXPORT_ROW_CAP) {
    const remaining = EXPORT_ROW_CAP - rows.length;
    const pageLimit = Math.min(CITATIONS_PAGE_SIZE, remaining);
    const page = await deps.storage.listCitations({ workspaceId, limit: pageLimit, offset });
    if (page.length === 0) break;
    rows.push(...page);
    offset += page.length;
    if (page.length < pageLimit) break;
  }
  return rows.slice(0, EXPORT_ROW_CAP).map(toLegacyCitationExportRow);
}

/**
 * Full 4-resource workspace export — the pure-core replacement for legacy
 * `CoreLike.exportWorkspace`. Backs `GET`/`POST /export` (`routes/export.ts`).
 */
export async function exportWorkspace(
  deps: ExportWorkspaceDeps,
  workspaceId: string,
  maxSensitivity?: Sensitivity
): Promise<LegacyWorkspaceExport> {
  const [facts, decisions, relations, citations] = await Promise.all([
    exportFacts(deps, workspaceId, maxSensitivity),
    exportDecisions(deps, workspaceId),
    exportRelations(deps, workspaceId),
    exportCitations(deps, workspaceId),
  ]);
  return { facts, decisions, relations, citations };
}
