/**
 * 7-stage cold retrieval cascade — the primary recall path when the hot tier misses.
 * COGNITIVE_ALGORITHMS.md §5, AUDIT_REPORT.md ALG-03.
 *
 * Stages:
 *   1. Parse query → semantic embedding + filters
 *   2. Candidate search over every recallable kind — HNSW over facts, cosine over
 *      decisions/other kinds and entities (plus FTS arms in hybrid) — keeping the
 *      raw cosine and the lexical rank of each candidate apart (WP-3)
 *   3. Relation context and hyperedge HINTS for the served page (never injected
 *      as hits: RECALL-2)
 *   4. Petrov ACT-R activation A(t) = ln(∑ t_j^{-d}), d=0.5 (Anderson 1993),
 *      read from the recall log — a bounded tie-breaker only
 *   5. Score = relevance × kind weight × worth prior × activation tie-break,
 *      where relevance is the cosine (RRF in hybrid). WP-3 (RECALL-1): the old
 *      blend `(tanh(A) × 0.4 + cosine × 0.6) × worth` gave 40% of the score to
 *      how recently a memory had been recalled — a signal that ignores the
 *      query and that every served hit raised for itself. See recall-relevance.ts.
 *   6. Sensitivity ceiling (CaMeL anti-probing: 404 not 403 — NEW-02)
 *      Contested facts are included but flagged; callers render warnings not redactions.
 *   7. Assemble RecallHit[] with structured security labels (NEVER interpolated inline)
 */

import type {
  RecallQuery,
  RecallResponse,
  RecallTraceStage,
  RecallHit,
  RecallHitStatus,
  AuthContext,
  PrimitiveKind,
  Provenance,
  Sensitivity,
  RecallFilter,
  MnemoFact,
  MnemoDecision,
  MnemoEpisode,
  MnemoEntity,
  MnemoStrategy,
  MnemoWorkflow,
  MnemoSkill,
  MnemoTask,
  MnemoEvent,
  MnemoReasoning,
  DerivedInference,
  Span,
  RecallPrimitiveRecord,
  RecallPrimitiveRef,
  StorageAdapter,
  ActorType,
  PrimitiveCandidate,
} from "@mnemo-ai/types";
import {
  MNEMO_SPAN_NAMES,
  SENSITIVITY_ORDER,
  isSensitiveTier,
  sensitiveTextMayReachEmbedder,
  sensitiveTextMayReachLlm,
  RECALLABLE_KINDS,
  projectPrimitiveText,
  DEFAULT_RECALL_KINDS,
  PRIMITIVE_KINDS,
  PRIMITIVE_SUBTYPES,
} from "@mnemo-ai/types";
import type { CoreContext } from "./context.js";
import { appliesOrganicEffects } from "./recall-effects.js";
import { composeInferences } from "./compositionality.js";
import { isUntestedWorth, passesWorthGate, worthGateLowerBound } from "./worth.js";
import { recordCoRecall } from "./co-recall.js";
import { hybridRecallWeights } from "../resilience/embedMigration.js";
import { decideRecmem } from "./recmem.js";
import { reportLlmUsage } from "./llm-usage.js";
import { scoreInjection, DEFAULT_INJECTION_THRESHOLD } from "../security/injection.js";
import { generateHydeDoc } from "./hyde.js";
import { isRecallableFact } from "./fact-lifecycle.js";
import { matchesRecallFilter } from "./recall-filter.js";
import { hitFreshness } from "./freshness.js";
import { parseJsonReply } from "../llm/parse-json-reply.js";
import {
  ACTIVATION_TIE_BREAK,
  activationFactor,
  cosineSimilarity,
  worthFactor,
  defaultRelevanceFloor,
  isNothingRelevant,
  SemanticSearchUnavailableError,
} from "./recall-relevance.js";

export const RECALL_RRF_K = 60;

/**
 * Weighted RRF over a semantic and a lexical rank (1-based; undefined = the
 * arm did not return the id), normalised so rank 1 in both arms scores 1.
 */
function rrfScore(
  semanticRank: number | undefined,
  lexicalRank: number | undefined,
  migrationActive: boolean
): number {
  const semantic = semanticRank !== undefined ? 1 / (RECALL_RRF_K + semanticRank) : 0;
  const lexical = lexicalRank !== undefined ? 1 / (RECALL_RRF_K + lexicalRank) : 0;
  const weights = hybridRecallWeights(migrationActive);
  return (
    (semantic * (weights.vector / 0.6) + lexical * (weights.fts / 0.4)) / (2 / (RECALL_RRF_K + 1))
  );
}

// ─── Normalised primitive view ────────────────────────────────────────────────
// Extract only the fields we need for scoring and recall assembly.

interface PrimitiveView {
  worth?: number;
  worthLowerBound?: number; // Wilson-score 95% CI lower bound; only for facts
  // True when worthAlpha/worthBeta are still at the exact Beta(2,2) neutral
  // prior — i.e. the fact has zero recall observations either way. Exempts
  // brand-new facts from passesWorthGate() (see worth.ts bugfix note).
  isUntested?: boolean;
  sensitivity: Sensitivity;
  provenance?: Provenance;
  content: string;
  validFrom: Date;
  validTo: Date | null;
  tags: string[];
  contested: boolean;
  factKind?: string; // only present for fact primitives (Wave H)
  scope?: RecallHit["scope"];
  scopeRef?: string;
  scopeOwner?: string; // multi-tenant ownership label, only for fact primitives
  actorId?: string | null; // P11 — attribution; null for pre-attribution rows
  userId?: string | null; // platform account behind the write, when one exists
  actorType?: ActorType;
  confidence?: number;
  entityId?: string;
  entityIds?: string[];
  sessionId?: string;
  factStatus?: MnemoFact["status"];
  lifecycle: "active" | "archived" | "excluded";
  topicKey?: string; // WP-3 (AGENTSIM-4): shown on hits so a writer can supersede
  subject?: string; // facts only
}

// Spec §17: Tier 3 "Always → promote top-3 to hot tier". Inlined (not imported
// from recall-hot, which would be a circular dep). Fire-and-forget; never throws.
async function coldBumpHotTier(
  ctx: CoreContext,
  workspaceId: string,
  factId: string
): Promise<void> {
  if (!ctx.cache?.zincrby) return Promise.resolve();
  const key = `mnemo:${workspaceId}:hot:facts`;
  return ctx.cache
    .zincrby(key, 1, factId)
    .then(() => undefined)
    .catch(() => undefined);
}

// Exported for the §17/§5 cold-tier sensitivity regression test.
export function viewFact(f: MnemoFact): PrimitiveView {
  return {
    worth: f.worth ?? 0.5,
    // Wilson-score lower bound using Beta(2,2) prior defaults (spec §6)
    worthLowerBound: worthGateLowerBound(f),
    isUntested: isUntestedWorth(f),
    // SECURITY (§17/§5): use the fact's REAL stored sensitivity — never a
    // hardcoded "internal". Hardcoding leaked confidential/restricted facts to
    // non-admin callers through the cold cascade (the ceiling is enforced at
    // sensitivityAllowed() below on this value). Facts are the PII-bearing
    // primitive; mapRowToFact populates the real column.
    sensitivity: f.sensitivity ?? "internal",
    provenance: (f.attribution as Provenance) ?? "user_stated",
    content: f.statement,
    validFrom: f.validFrom,
    validTo: f.validTo ?? null,
    tags: Array.isArray(f.metadata?.tags)
      ? f.metadata.tags.filter((tag): tag is string => typeof tag === "string")
      : [],
    contested: false,
    factKind: f.kind, // Wave H: enables engine fact_kind clause matching
    scope: f.scope,
    scopeRef: f.scopeRef,
    scopeOwner: f.scopeOwner,
    topicKey: f.topicKey,
    subject: f.subject,
    actorId: f.actorId ?? null, // P11 — attribution field
    userId: f.userId ?? null,
    actorType: f.actorType,
    confidence: f.confidence,
    entityId: f.entityId,
    sessionId: f.sessionId,
    factStatus: f.status,
    lifecycle:
      f.status === "active" && f.validTo == null
        ? "active"
        : f.status === "forgotten" && f.validTo != null
          ? "archived"
          : "excluded",
  };
}

function viewDecision(d: MnemoDecision): PrimitiveView {
  return {
    sensitivity: d.sensitivity ?? "internal",
    // make-primitives-recallable (design.md D4/Interfaces, PR4): what is
    // returned must match what was indexed (PRIMITIVE_TEXT_PROJECTION.decision
    // = [title, body]) — a title-only match used to render as an unrelated
    // body. No live consumer existed before this PR (the path was unreachable).
    content: `${d.title}\n\n${d.body}`,
    validFrom: d.validFrom,
    validTo: d.validTo ?? null,
    tags: metadataTags(d.metadata),
    contested: false,
    confidence: d.confidence,
    scopeRef: d.scopeRef,
    scopeOwner: d.scopeOwner,
    topicKey: d.topicKey,
    actorId: d.actorId ?? null,
    userId: d.userId ?? null,
    actorType: d.actorType,
    lifecycle: d.status === "active" && d.validTo == null ? "active" : "archived",
  };
}

function viewEpisode(e: MnemoEpisode): PrimitiveView {
  return {
    sensitivity: e.sensitivity ?? "internal",
    content: e.narrative,
    // P18: use real bitemporal columns; fallback to occurredAt for pre-migration rows
    validFrom: e.validFrom ?? e.occurredAt,
    validTo: e.validTo ?? null,
    tags: e.topics ?? [],
    contested: false,
    scopeOwner: e.scopeOwner,
    actorId: e.actorId ?? null,
    userId: e.userId ?? null,
    actorType: e.actorType,
    sessionId: e.sourceConversationId,
    lifecycle: e.validTo == null ? "active" : "archived",
  };
}

function viewEntity(e: MnemoEntity): PrimitiveView {
  return {
    // P16 / S6: use the entity's real stored sensitivity so the ceiling filter
    // (sensitivityAllowed) correctly excludes restricted/confidential entities
    // from callers without the required clearance. Defaults to "internal" when
    // the sensitivity column is null (pre-P15 rows).
    sensitivity: e.sensitivity ?? "internal",
    // P65: what a hit SHOWS must be what the index MATCHED on. These built
    // `description ?? title` — display one field while
    // PRIMITIVE_TEXT_PROJECTION indexes both — so an agent could search by
    // title, match, and get back a fragment that does not contain what it
    // searched for. Measured against the live stack: a task recalled by
    // "rotar credenciales" came back as `content: "vence pronto"`.
    // Harmless while these kinds were write-only; a real defect the moment
    // P65 made them recallable.
    // `entity` is deliberately NOT in RECALLABLE_KINDS (it has its own path,
    // findSimilarEntities, P16), so it has no PRIMITIVE_TEXT_PROJECTION entry
    // and must keep its own projection here.
    content: e.description ?? e.name,
    // P18: use real bitemporal columns; fallback to createdAt for pre-migration rows
    validFrom: e.validFrom ?? e.createdAt,
    validTo: e.validTo ?? null,
    tags: metadataTags(e.metadata),
    contested: false,
    scopeOwner: e.scopeOwner,
    actorId: e.actorId ?? null,
    userId: e.userId ?? null,
    actorType: e.actorType,
    lifecycle: e.validTo == null ? "active" : "archived",
  };
}

function viewStrategy(s: MnemoStrategy): PrimitiveView {
  return {
    worth: s.worth,
    sensitivity: s.sensitivity ?? "internal",
    provenance: s.attribution,
    content: `${s.trigger} → ${s.action}`,
    validFrom: s.validFrom,
    validTo: s.validTo ?? null,
    tags: metadataTags(s.metadata),
    contested: false,
    scopeRef: s.scopeRef,
    scopeOwner: s.scopeOwner,
    actorId: s.actorId ?? null,
    userId: s.userId ?? null,
    actorType: s.actorType,
    lifecycle: s.status === "active" && s.validTo == null ? "active" : "archived",
  };
}

function viewWorkflow(w: MnemoWorkflow): PrimitiveView {
  return {
    worth: w.worth,
    sensitivity: w.sensitivity ?? "internal",
    content:
      projectPrimitiveText("workflow", w as unknown as Record<string, unknown>) ||
      (w.description ?? w.name),
    // P18: use real bitemporal columns; fallback to createdAt for pre-migration rows
    validFrom: w.validFrom ?? w.createdAt,
    validTo: w.validTo ?? null,
    tags: metadataTags(w.metadata),
    contested: false,
    scopeRef: w.scopeRef,
    scopeOwner: w.scopeOwner,
    actorId: w.actorId ?? null,
    userId: w.userId ?? null,
    actorType: w.actorType,
    lifecycle:
      w.status === "active" && w.validTo == null
        ? "active"
        : w.status === "deprecated"
          ? "archived"
          : "excluded",
  };
}

function viewSkill(s: MnemoSkill): PrimitiveView {
  return {
    worth: s.worth,
    sensitivity: s.sensitivity ?? "internal",
    content: s.promptTemplate,
    // P18: use real bitemporal columns; fallback to createdAt for pre-migration rows
    validFrom: s.validFrom ?? s.createdAt,
    validTo: s.validTo ?? null,
    tags: metadataTags(s.metadata),
    contested: false,
    scopeOwner: s.scopeOwner,
    actorId: s.actorId ?? null,
    userId: s.userId ?? null,
    actorType: s.actorType,
    lifecycle: s.validTo == null ? "active" : "archived",
  };
}

function viewTask(t: MnemoTask): PrimitiveView {
  return {
    sensitivity: t.sensitivity ?? "internal",
    content:
      projectPrimitiveText("task", t as unknown as Record<string, unknown>) ||
      (t.description ?? t.title),
    validFrom: t.validFrom,
    validTo: t.validTo ?? null,
    tags: metadataTags(t.metadata),
    contested: false,
    scopeOwner: t.scopeOwner,
    actorId: t.actorId ?? null,
    userId: t.userId ?? null,
    actorType: t.actorType,
    sessionId: t.sessionId,
    lifecycle: t.status === "cancelled" || t.validTo != null ? "archived" : "active",
  };
}

function metadataTags(metadata?: Record<string, unknown>): string[] {
  return Array.isArray(metadata?.tags)
    ? metadata.tags.filter((tag): tag is string => typeof tag === "string")
    : [];
}

function viewEvent(e: MnemoEvent): PrimitiveView {
  return {
    sensitivity: e.sensitivity ?? "internal",
    content:
      projectPrimitiveText("event", e as unknown as Record<string, unknown>) || e.description,
    validFrom: e.occurredAt,
    validTo: null,
    tags: metadataTags(e.metadata),
    contested: false,
    entityIds: e.relatedEntities,
    scopeOwner: e.scopeOwner,
    lifecycle: "active",
  };
}

function viewReasoning(r: MnemoReasoning): PrimitiveView {
  return {
    worth: r.worth,
    sensitivity: r.sensitivity ?? "internal",
    content: r.conclusion,
    // P64: real bitemporal columns — status remains the retrieval gate,
    // validTo is the audit axis only (see primitives.ts's MnemoReasoning doc).
    validFrom: r.validFrom,
    validTo: r.validTo ?? null,
    tags: metadataTags(r.metadata),
    contested: false,
    scopeOwner: r.scopeOwner,
    lifecycle:
      r.status === "active" || r.status === "golden"
        ? "active"
        : r.status === "archived" || r.status === "pruned"
          ? "archived"
          : "excluded",
  };
}

// ─── Primitive fetch dispatcher ───────────────────────────────────────────────

/**
 * The primitive kinds a vector hit may hydrate as, in lookup order.
 *
 * PgVectorAdapter searches mnemo_fact and reports its `kind` column, which there
 * is the FACT kind (PRIMITIVE_SUBTYPES.fact: preference, trait, event, …,
 * other) — not the primitive kind. Only "other" used to be remapped, so every
 * fact of another kind was hydrated under a kind with no table and dropped in
 * silence. A value that is not a primitive kind is a fact; one in both
 * vocabularies (event, skill) is tried as that primitive, then as a fact.
 */
export function vectorHitKinds(primitiveKind: string | undefined): RecallPrimitiveRef["kind"][] {
  if (primitiveKind === "hyperedge") return [];
  if (
    primitiveKind === undefined ||
    !(PRIMITIVE_KINDS as readonly string[]).includes(primitiveKind)
  )
    return ["fact"];
  const kind = primitiveKind as RecallPrimitiveRef["kind"];
  return kind !== "fact" && (FACT_KINDS as readonly string[]).includes(kind)
    ? [kind, "fact"]
    : [kind];
}

function isUnambiguousFactVectorHit(primitiveKind: string | undefined): boolean {
  // "skill" and "event" may hydrate as primitives, so cannot enter a fact-only
  // score calculation until their actual table has been resolved.
  const kinds = vectorHitKinds(primitiveKind);
  return kinds.length === 1 && kinds[0] === "fact";
}

const FACT_KINDS = PRIMITIVE_SUBTYPES.fact satisfies readonly MnemoFact["kind"][];

async function fetchView(
  ctx: CoreContext,
  id: string,
  kind: PrimitiveKind,
  workspaceId: string
): Promise<PrimitiveView | null> {
  // v3.remember() writes kind="other" into mnemo_fact.kind for all user-created
  // facts. The "kind" column is a fact sub-type discriminator, not the primitive
  // kind. Remap to "fact" so the switch routes to getFact and returns real data
  // instead of falling through to the default null case → DEFAULT_VIEW.
  const effectiveKind: PrimitiveKind = (kind as string) === "other" ? "fact" : kind;
  switch (effectiveKind) {
    case "fact": {
      const p = await ctx.storage.getFact(id, workspaceId);
      return p ? viewFact(p) : null;
    }
    case "decision": {
      const p = await ctx.storage.getDecision(id, workspaceId);
      return p ? viewDecision(p) : null;
    }
    case "episode": {
      const p = await ctx.storage.getEpisode(id, workspaceId);
      if (!p) return null;
      // §16/§17: delta-encoded episodes store only the diff from their parent in
      // `narrative`/`deltaContent`. Reconstruct the full root→leaf narrative at
      // read time so recall returns the complete text, not a bare delta. Only
      // non-root episodes need this; roots are already whole. Falls back to the
      // stored narrative if reconstruction fails (e.g. broken parent chain).
      if (p.parentEpisodeId && ctx.storage.reconstructEpisode) {
        const reconstructed = await ctx.storage
          .reconstructEpisode(id, workspaceId)
          .catch(() => null);
        if (reconstructed) return viewEpisode(reconstructed);
      }
      return viewEpisode(p);
    }
    case "entity": {
      const p = await ctx.storage.getEntity(id, workspaceId);
      return p ? viewEntity(p) : null;
    }
    case "strategy": {
      const p = await ctx.storage.getStrategy(id, workspaceId);
      return p ? viewStrategy(p) : null;
    }
    case "workflow": {
      const p = await ctx.storage.getWorkflow(id, workspaceId);
      return p ? viewWorkflow(p) : null;
    }
    case "skill": {
      const p = await ctx.storage.getSkill(id, workspaceId);
      return p ? viewSkill(p) : null;
    }
    case "task": {
      const p = await ctx.storage.getTask(id, workspaceId);
      return p ? viewTask(p) : null;
    }
    case "event": {
      const p = await ctx.storage.getEvent(id, workspaceId);
      return p ? viewEvent(p) : null;
    }
    case "reasoning": {
      const p = await ctx.storage.getReasoning(id, workspaceId);
      return p ? viewReasoning(p) : null;
    }
    case "hyperedge":
      // Hyperedges are not vector-indexed for recall — return null to skip scoring
      return null;
    default:
      return null;
  }
}

function viewRecallPrimitive(record: RecallPrimitiveRecord): PrimitiveView | null {
  switch (record.kind) {
    case "fact":
      return viewFact(record.value as MnemoFact);
    case "decision":
      return viewDecision(record.value as MnemoDecision);
    case "episode":
      return viewEpisode(record.value as MnemoEpisode);
    case "entity":
      return viewEntity(record.value as MnemoEntity);
    case "strategy":
      return viewStrategy(record.value as MnemoStrategy);
    case "workflow":
      return viewWorkflow(record.value as MnemoWorkflow);
    case "skill":
      return viewSkill(record.value as MnemoSkill);
    case "task":
      return viewTask(record.value as MnemoTask);
    case "event":
      return viewEvent(record.value as MnemoEvent);
    case "reasoning":
      return viewReasoning(record.value as MnemoReasoning);
  }
}

// ─── Petrov ACT-R activation ──────────────────────────────────────────────────
// A(t) = ln(∑ t_j^{-d}) where d=0.5, t_j = seconds since j-th recall.
// ALG-03: use this formula, NOT the simplified ln(n/t).
//
// Why ln(∑ t^{-d}) and not ln(n/t)?
//   ln(n/t) treats all recalls equally regardless of recency. The power-law
//   decay t^{-d} gives exponentially more credit to recent recalls while still
//   accumulating credit for older ones. Math.max(..., 1) floors to 1s so
//   t=0 doesn't produce Infinity.

export function petrovActivation(recallTimestampsMs: number[], nowMs: number, d = 0.5): number {
  if (recallTimestampsMs.length === 0) return 0;
  const sum = recallTimestampsMs.reduce((acc, ts) => {
    const secondsAgo = Math.max((nowMs - ts) / 1000, 1);
    return acc + Math.pow(secondsAgo, -d);
  }, 0);
  return Math.log(sum);
}

// ─── Sensitivity ceiling ──────────────────────────────────────────────────────

/** The highest tier `auth` may read: its explicit ceiling, never above what its scopes allow. */
export function effectiveCeiling(auth: AuthContext): Sensitivity {
  const scopeCeiling: Sensitivity = auth.scopes.includes("memory:admin")
    ? "restricted"
    : "internal";
  const explicitCeiling = auth.maxSensitivity ?? scopeCeiling;
  return SENSITIVITY_ORDER[explicitCeiling] <= SENSITIVITY_ORDER[scopeCeiling]
    ? explicitCeiling
    : scopeCeiling;
}

export function sensitivityAllowed(hitSensitivity: Sensitivity, auth: AuthContext): boolean {
  return SENSITIVITY_ORDER[hitSensitivity] <= SENSITIVITY_ORDER[effectiveCeiling(auth)];
}

export function recallFilterForAuth(
  filter: RecallFilter | undefined,
  auth: AuthContext
): RecallFilter {
  const levels: Sensitivity[] = ["public", "internal", "confidential", "restricted"];
  const sensitivity = levels.filter(
    (level) =>
      sensitivityAllowed(level, auth) &&
      (filter?.sensitivity === undefined || filter.sensitivity.includes(level))
  );
  return { ...(filter ?? {}), sensitivity };
}

// ─── §36 Migration reweight (F28) ─────────────────────────────────────────────

/**
 * §36: scale a hit's vector-derived score during an active embedding migration so
 * recall leans on the model-agnostic FTS signal. Pure — exported for unit tests.
 *
 *   - Pure-vector hit  (isFtsOnly=false): multiply by weights.vector / 0.6
 *   - FTS-only hit      (isFtsOnly=true):  multiply by weights.fts    / 0.4
 *
 * When migrationActive=false the helper is the IDENTITY (both ratios = 1.0),
 * preserving the pre-F28 score exactly. The 0.6 / 0.4 denominators are the spec's
 * "normal" weights (lines 4642-4643), so the ratio is 1.0 in normal mode.
 */
export function applyMigrationReweight(
  hit: { vectorScore: number; isFtsOnly: boolean },
  migrationActive: boolean
): number {
  const w = hybridRecallWeights(migrationActive);
  const factor = hit.isFtsOnly ? w.fts / 0.4 : w.vector / 0.6;
  return hit.vectorScore * factor;
}

// ─── WP-3 candidate evidence ─────────────────────────────────────────────────

/** One cold-recall candidate and the evidence each arm produced for it. */
interface ColdCandidate {
  id: string;
  /** Vector-hit kind (a fact kind for mnemo_fact rows), or the primitive kind. */
  primitiveKind: string | undefined;
  /** Raw cosine from a semantic arm. Absent for lexical-only candidates. */
  similarity?: number;
  /** 1-based position in the lexical arm that matched it (hybrid only). */
  lexicalRank?: number;
  /** Per-kind weight: 0.85 for entities, 1 for everything else. */
  kindWeight: number;
}

/** Content key for exact-duplicate suppression: case and whitespace do not count. */
function normalizedContent(content: string): string {
  return content.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * AGENTSIM-4: set `status`/`contested` on hits that have no status yet, from
 * one batched lookup of unresolved `conflicts_with` relations. Closed rows
 * (`validTo` set) are `superseded`. Without the port, open rows read `active`.
 * Mutates and returns `hits`.
 */
export async function stampHitStatus(
  ctx: CoreContext,
  workspaceId: string,
  hits: RecallHit[],
  auth: AuthContext
): Promise<RecallHit[]> {
  const open = hits.filter((hit) => hit.status === undefined && hit.validTo == null);
  const lookup = (ctx.storage as Partial<Pick<StorageAdapter, "getUnresolvedConflictIds">>)
    .getUnresolvedConflictIds;
  const conflictIds =
    lookup && open.length > 0
      ? new Set(
          await lookup
            .call(
              ctx.storage,
              workspaceId,
              open.map((hit) => hit.id),
              effectiveCeiling(auth)
            )
            .catch(() => [] as string[])
        )
      : new Set<string>();
  for (const hit of hits) {
    if (hit.status !== undefined) continue;
    hit.status =
      hit.validTo != null ? "superseded" : conflictIds.has(hit.id) ? "contested" : "active";
    hit.contested = hit.status === "contested";
  }
  return hits;
}

/** AGENTSIM-4: closed rows read as superseded, open disputed rows as contested. */
/**
 * Point-in-time recall (`asOf`): the row's validity interval contains the
 * instant. The same rule as GET /facts?asOf; status is not consulted, because
 * a row closed or merged after the instant was the live one at it.
 */
export function heldAt(row: { validFrom?: Date | null; validTo?: Date | null }, at: Date): boolean {
  return (
    (row.validFrom == null || row.validFrom <= at) && (row.validTo == null || row.validTo > at)
  );
}

function hitStatus(view: Pick<PrimitiveView, "lifecycle">, contested: boolean): RecallHitStatus {
  if (view.lifecycle !== "active") return "superseded";
  return contested ? "contested" : "active";
}

// ─── Main: cold cascade ───────────────────────────────────────────────────────

/** Deterministic tie-break for equal scores: ascending id. */
function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Opt-in stage tracing (`query.debug === true`). Returns `[undefined, no-op]`
 * otherwise, so an untraced recall makes no `performance.now()` calls. Each
 * stage's `ms` is the time since the previous mark: the pipeline is sequential.
 */
export function startTrace(
  enabled: boolean | undefined,
  auth: AuthContext
): [
  RecallTraceStage[] | undefined,
  (name: string, candidatesIn: number, candidatesOut?: number) => void,
] {
  if (enabled !== true) return [undefined, () => undefined];
  const stages: RecallTraceStage[] = [];
  let last = performance.now();
  return [
    stages,
    (name, candidatesIn, candidatesOut = candidatesIn) => {
      const now = performance.now();
      stages.push({
        name,
        ...traceCounts(name, candidatesIn, candidatesOut, auth),
        ms: now - last,
      });
      last = now;
    },
  ];
}

/**
 * The counts a stage may report to this caller. Stages before `eligibility`
 * count candidates the sensitivity ceiling has not filtered yet (the vector
 * port has no ceiling), so they would tell a limited caller whether a memory
 * it cannot read sits near the query. Unless the caller's ceiling admits every
 * tier they report null, and `eligibility` reports only what passed it.
 */
export function traceCounts(
  name: string,
  candidatesIn: number,
  candidatesOut: number,
  auth: AuthContext
): Pick<RecallTraceStage, "candidatesIn" | "candidatesOut"> {
  if (sensitivityAllowed("restricted", auth)) return { candidatesIn, candidatesOut };
  const stage = TRACE_ORDER.indexOf(name);
  const eligibility = TRACE_ORDER.indexOf("eligibility");
  if (stage === eligibility) return { candidatesIn: candidatesOut, candidatesOut };
  return stage < eligibility
    ? { candidatesIn: null, candidatesOut: null }
    : { candidatesIn, candidatesOut };
}

const TRACE_ORDER = [
  "embed",
  "hot_tier",
  "pointer_tier",
  "cache",
  "vector",
  "lexical",
  "nonfact_candidates",
  "fusion",
  "eligibility",
  "dedup",
  "activation",
  "graph",
  "rerank",
  "response",
];

/**
 * Merge the orchestrator's stages with the ones the answering tier recorded
 * itself (which win on a name clash), in canonical pipeline order, and put them
 * on `resp.debug.trace`. Hot/pointer/cache answers carry no debug otherwise.
 */
export function attachTrace(
  resp: RecallResponse,
  stages: RecallTraceStage[],
  tier: string
): RecallResponse {
  const own = resp.debug?.trace ?? [];
  const ownNames = new Set(own.map((s) => s.name));
  const trace = [...stages.filter((s) => !ownNames.has(s.name)), ...own].sort(
    (a, b) => TRACE_ORDER.indexOf(a.name) - TRACE_ORDER.indexOf(b.name)
  );
  return {
    ...resp,
    debug: {
      modeRequested: "auto",
      modeUsed: "auto",
      tiersConsulted: [tier],
      cacheHit: tier === "l3_cache",
      fallback: false,
      ...resp.debug,
      trace,
    },
  };
}

export async function recallCold(
  ctx: CoreContext,
  query: RecallQuery,
  auth: AuthContext,
  parentSpan?: Span,
  // Default: the query's own effects flag, so a direct tier call never trains on
  // synthetic traffic. The cascade passes its boundary decision explicitly.
  runEffects = appliesOrganicEffects(query)
): Promise<RecallResponse> {
  const startMs = Date.now();
  const span = ctx.telemetry.startSpan("mnemo.recall.cold", {
    parent: parentSpan,
    attributes: { "mnemo.workspace_id": query.workspaceId },
  });

  const limit = query.limit ?? 10;
  const offset = query.offset ?? 0;
  const [trace, traceStage] = startTrace(query.debug, auth);
  const withTrace = (debug: NonNullable<RecallResponse["debug"]>) =>
    trace ? { ...debug, trace } : debug;

  try {
    const requestedMode =
      query.mode ??
      (query.vectorWeight === 0
        ? "lexical"
        : query.vectorWeight === 1
          ? "semantic"
          : query.vectorWeight !== undefined
            ? "hybrid"
            : "auto");
    const isFtsFallback =
      !query.embedding && (ctx.embed.model === "none" || query.embedderUnavailable === true);

    // B5.9: Semantic mode fails visibly if embedder unavailable (no silent fallback unless auto/hybrid/lexical)
    if (requestedMode === "semantic" && isFtsFallback) {
      throw new SemanticSearchUnavailableError(
        "embed adapter is not configured or unavailable for strict semantic search"
      );
    }

    /**
     * P128 — the lexical path, reachable from THREE places.
     *
     * It used to be reachable from two: an explicit `lexical` request, and an
     * embedder configured as absent (`model === "none"`). The third — the
     * embedder being configured and NOT ANSWERING — fell straight through to
     * `embedSingle` below and threw, so `POST /recall` returned 500 while the
     * tool descriptions promised a graceful fall back to full-text.
     *
     * That is the wrong half to cover. "No embedder configured" is a
     * deploy-time state you chose and already know about; "the provider is
     * down" is the one that arrives on its own, at night, and it is the one
     * users experience as the product being broken.
     *
     * Extracted into a closure rather than duplicated, because two copies of a
     * degradation path drift and the drift is invisible: both keep returning
     * results, just different ones.
     */
    const runLexicalPath = async (isFallback: boolean, reason: string) => {
      if (isFallback) {
        ctx.logger.info("recall.fts_fallback", {
          workspaceId: query.workspaceId,
          reason,
        });
      }
      const lexical = await lexicalRecall(ctx, query, auth);
      traceStage("lexical", lexical.candidateCount, lexical.hits.length);
      const modeUsed = isFallback ? "fts" : "lexical";
      // Attach lexical score baseline
      const hitsWithScore = lexical.hits.map((h) => ({
        ...h,
        lexicalScore: h.score,
      }));
      traceStage("response", hitsWithScore.length);
      return buildResponse(
        hitsWithScore,
        query.text,
        limit,
        offset,
        startMs,
        false,
        [],
        modeUsed,
        withTrace({
          modeRequested: requestedMode,
          modeUsed,
          spaceId: ctx.embed.model !== "none" ? `default:${ctx.embed.model}` : undefined,
          tiersConsulted: [modeUsed],
          cacheHit: false,
          fallback: isFallback,
          fusionApplied: false,
          lexicalCandidateCount: lexical.candidateCount,
          ftsFailed: lexical.ftsFailed,
        }),
        lexical.nothingRelevant
      );
    };

    // B5.3 / B5.9: Lexical-only mode, or an embedder configured as absent.
    if (requestedMode === "lexical" || isFtsFallback) {
      return runLexicalPath(isFtsFallback, "embed_adapter_unavailable");
    }

    // Stage 1: Get or compute embedding
    // HyDE pre-step (arXiv:2212.10496): when query.hyde=true, ask the LLM to write a
    // hypothetical answer doc and embed it, then average with the query embedding.
    // Degrades gracefully to plain query embedding when LLM absent or call fails.
    let rawEmbedding: Float32Array;
    if (query.embedding) {
      rawEmbedding = query.embedding;
    } else {
      try {
        rawEmbedding = await ctx.embed.embedSingle(query.text);
      } catch (err) {
        // P128: the provider is configured but did not answer.
        //
        // Strict `semantic` still THROWS — that contract (B5.9) is the reason
        // `memory_search` can promise anything at all about what ran, and
        // quietly handing back lexical results to a caller who asked for
        // vectors would make the mode meaningless. Every other mode degrades,
        // which is what the tool descriptions already say happens.
        //
        // `debug.searchMode` in the response reports `fts`, so a caller who
        // cares can tell it did not get what it asked for. Degrading in
        // silence has its own cost, and this is the line where that cost is
        // paid honestly.
        // CHAOS-5: typed, so the route answers 503 semantic_search_unavailable
        // instead of a bare 500; the provider's error stays as `cause`.
        if (requestedMode === "semantic") {
          throw new SemanticSearchUnavailableError("the embedding provider did not answer", {
            cause: err,
          });
        }
        ctx.logger.warn("recall.embed_failed_falling_back_to_fts", {
          workspaceId: query.workspaceId,
          model: ctx.embed.model,
          error: {
            type: err instanceof Error ? err.name : "Error",
            message: err instanceof Error ? err.message : String(err),
          },
        });
        return runLexicalPath(true, "embed_provider_unreachable");
      }
    }
    if (!query.embedding) traceStage("embed", 1);
    let embedding = rawEmbedding;
    if (query.hyde === true) {
      const hydeDoc = await generateHydeDoc(ctx, query.text);
      if (hydeDoc !== null) {
        const hVec = await ctx.embed.embedSingle(hydeDoc).catch(() => null);
        if (hVec !== null) {
          const dim = rawEmbedding.length;
          const averaged = new Float32Array(dim);
          for (let i = 0; i < dim; i++) {
            averaged[i] = (rawEmbedding[i]! + hVec[i]!) / 2;
          }
          embedding = averaged;
        }
      }
    }

    // Stage 2: semantic candidates — facts (HNSW over mnemo_fact) and entities,
    // concurrently. Over-fetch to the canonical bound so post-hydration filters
    // do not hide eligible candidates that rank below an ineligible prefix.
    // Entities keep a ×0.85 weight: they are contextual signals (a name and a
    // description), not answers, and should not displace an equally similar fact.
    const ENTITY_SCORE_DAMPEN = 0.85;
    // RECALL-6: an ownership filter goes INTO the semantic queries, before
    // their limits — filtering after a 1,000-candidate window lets workspace
    // memories fill it and leaves a personal-only recall empty.
    const owner = query.filter?.scopeOwner;

    const [vectorResults, entityResults] = await Promise.all([
      ctx.vector.search({
        workspaceId: query.workspaceId,
        vector: embedding,
        limit: 1000,
        minSimilarity: 0.1,
        ...(owner ? { filter: { scopeOwner: owner } } : {}),
      }),
      ctx.storage
        .findSimilarEntities?.(query.workspaceId, Array.from(embedding), 1000, 0.3)
        .catch(() => [] as Array<{ id: string; cosine: number }>) ??
        Promise.resolve([] as Array<{ id: string; cosine: number }>),
    ]);

    // WP-3: evidence is kept per candidate and per arm. `similarity` is the raw
    // cosine, whatever the kind; `lexicalRank` the 1-based position in the
    // lexical arm that matched it. Ranking reads these — never a score another
    // arm already blended, which is how a ts_rank used to pass for a cosine.
    const floor = query.minSimilarity;
    const candidates = new Map<string, ColdCandidate>();
    // An explicit floor is a statement about the semantic evidence: a candidate
    // the semantic arm measured below it is out, even if the lexical arm also
    // matched it (it used to come back as "lexical-only" and skip the floor).
    const belowFloor = new Set<string>();
    const addSemantic = (
      id: string,
      primitiveKind: string | undefined,
      similarity: number,
      kindWeight = 1
    ) => {
      if (floor !== undefined && similarity < floor) {
        belowFloor.add(id);
        return;
      }
      const existing = candidates.get(id);
      if (!existing) {
        candidates.set(id, { id, primitiveKind, similarity, kindWeight });
      } else if (existing.similarity === undefined || similarity > existing.similarity) {
        existing.similarity = similarity;
      }
    };
    const addLexical = (id: string, primitiveKind: string, lexicalRank: number) => {
      if (belowFloor.has(id)) return;
      const existing = candidates.get(id);
      if (!existing) candidates.set(id, { id, primitiveKind, lexicalRank, kindWeight: 1 });
      else existing.lexicalRank ??= lexicalRank;
    };
    for (const vr of vectorResults) addSemantic(vr.id, vr.primitiveKind, vr.score);
    for (const ent of entityResults) {
      if (candidates.has(ent.id)) continue;
      addSemantic(ent.id, "entity", ent.cosine, ENTITY_SCORE_DAMPEN);
    }
    traceStage("vector", vectorResults.length + entityResults.length, candidates.size);

    // Hybrid FTS arm: B5.5 / B5.1 enabled when requestedMode === "hybrid" or query.hybridFts === true
    const isHybridMode = requestedMode === "hybrid" || query.hybridFts === true;
    const terms = query.text.split(/\s+/).filter((t) => t.length > 0);
    const migrationActive =
      query.embeddingMigrationActive ??
      (ctx.storage.hasActiveEmbeddingMigration
        ? await ctx.storage
            .hasActiveEmbeddingMigration(query.workspaceId, ctx.embed.model)
            .catch(() => false)
        : false);
    let lexicalCandidateCount = 0;
    let ftsFailed = false;
    if (isHybridMode && ctx.storage.ftsCandidates) {
      const ftsRows = await ctx.storage
        .ftsCandidates({
          workspaceId: query.workspaceId,
          terms,
          limit: 1000,
          filter: recallFilterForAuth(query.filter, auth),
          includeArchived: query.includeArchived,
          includeLowWorth: query.includeLowWorth ?? false,
          relaxedOnEmpty: true,
          ...(query.asOf ? { asOf: query.asOf } : {}),
        })
        .catch((err: unknown) => {
          ftsFailed = true;
          logLexicalFailure(ctx, query.workspaceId, err);
          return [];
        });
      lexicalCandidateCount += ftsRows.length;
      const beforeFts = candidates.size;
      ftsRows.forEach((row, index) => {
        // A fact the vector window did not return still has a stored vector:
        // measure it, so the floor and the semantic rank see real evidence
        // instead of treating the row as "lexical-only" (review, RECALL-3).
        if (
          !candidates.has(row.factId) &&
          !belowFloor.has(row.factId) &&
          row.embedding &&
          row.embedding.length === embedding.length
        ) {
          addSemantic(row.factId, "fact", cosineSimilarity(embedding, row.embedding));
        }
        addLexical(row.factId, "fact", index + 1);
      });
      traceStage("lexical", ftsRows.length, candidates.size - beforeFts);
    }

    // make-primitives-recallable (design.md D4): non-fact recall candidates.
    // `kinds` DRIVES which kinds are searched — it is NOT a post-filter here —
    // so `filter.kinds` without "decision" issues no `recallableCandidates`
    // call at all; `matchesRecallFilter` still applies `filter.kinds` to facts.
    // WP-3 (RECALL-4): no ×0.85 damping any more. A decision whose cosine
    // matches a fact's ranks with it — damping plus the activation blend put
    // 0/8 decision answers in the default top 5. 0.35 only bounds what the
    // (sequential-scan) arm fetches; an explicit floor above it applies too.
    const effectiveRecallKinds: readonly PrimitiveKind[] =
      query.filter?.kinds ?? DEFAULT_RECALL_KINDS;
    const nonFactRecallableKinds = RECALLABLE_KINDS.filter(
      (kind) => kind !== "fact" && effectiveRecallKinds.includes(kind)
    );
    const NON_FACT_CANDIDATE_MIN_SIMILARITY = 0.35;
    if (nonFactRecallableKinds.length > 0 && ctx.storage.recallableCandidates) {
      const sendTerms = isHybridMode && terms.length > 0;
      const nonFactRows = await ctx.storage
        .recallableCandidates({
          workspaceId: query.workspaceId,
          kinds: nonFactRecallableKinds,
          limit: 1000,
          ...(owner ? { scopeOwner: owner } : {}),
          embedding: Array.from(embedding),
          minSimilarity: Math.max(NON_FACT_CANDIDATE_MIN_SIMILARITY, floor ?? 0),
          ...(sendTerms ? { terms, relaxedOnEmpty: true } : {}),
          ...(query.asOf ? { asOf: query.asOf } : {}),
        })
        .catch(() => [] as PrimitiveCandidate[]);
      // Their own lexical list: a ts_rank over decisions is not on the scale of
      // the fact FTS arm's, so each list contributes its own positions.
      const lexicalOrder = nonFactRows
        .filter((row) => row.lexicalRank !== undefined)
        .sort((a, b) => b.lexicalRank! - a.lexicalRank!);
      lexicalCandidateCount += lexicalOrder.length;
      const beforeNonFact = candidates.size;
      const lexicalPosition = new Map(lexicalOrder.map((row, index) => [row.id, index + 1]));
      for (const row of nonFactRows) {
        // An adapter that predates per-arm evidence reports one `score`: the
        // cosine, which is what it was taken for before.
        const legacy = row.similarity === undefined && row.lexicalRank === undefined;
        const similarity = legacy ? row.score : row.similarity;
        if (similarity !== undefined) addSemantic(row.id, row.kind, similarity);
        const position = lexicalPosition.get(row.id);
        if (position !== undefined) addLexical(row.id, row.kind, position);
      }
      traceStage("nonfact_candidates", nonFactRows.length, candidates.size - beforeNonFact);
    }

    const fusionApplied =
      isHybridMode && [...candidates.values()].some((c) => c.lexicalRank !== undefined);

    // F28 (§36) / B5.8: is this recall running mid-embedding-migration for the workspace?
    const modeUsed = isHybridMode
      ? fusionApplied
        ? "hybrid"
        : "semantic"
      : requestedMode === "semantic"
        ? "semantic"
        : "auto";
    const relevanceFloor = query.relevanceFloor ?? defaultRelevanceFloor(ctx.embed.model);
    const debugMetadata: NonNullable<RecallResponse["debug"]> = {
      modeRequested: requestedMode,
      modeUsed,
      spaceId: `default:${ctx.embed.model}`,
      tiersConsulted: [modeUsed, "cold"],
      cacheHit: false,
      fallback: false,
      fusionApplied,
      lexicalCandidateCount,
      ftsFailed,
      ...(relevanceFloor !== undefined ? { relevanceFloor } : {}),
    };

    if (candidates.size === 0) {
      // A limited caller's trace keeps the stages of a recall whose only
      // candidates it may not read, so their absence tells it nothing.
      if (!sensitivityAllowed("restricted", auth)) {
        for (const name of ["fusion", "eligibility", "dedup", "activation", "graph", "rerank"])
          traceStage(name, 0);
      }
      traceStage("response", 0);
      return buildResponse(
        [],
        query.text,
        limit,
        offset,
        startMs,
        false,
        [],
        modeUsed,
        withTrace(debugMetadata),
        true
      );
    }

    // Relevance — the base of every score. Semantic modes: the cosine. Hybrid
    // with lexical evidence: one reciprocal-rank fusion over ONE semantic list
    // (every kind, by cosine) and the lexical lists, so a decision and a fact
    // are scored by the same rule (P162: facts used to get RRF while decisions
    // kept a damped cosine, on different scales).
    const semanticRank = new Map<string, number>();
    if (fusionApplied) {
      [...candidates.values()]
        .filter((c) => c.similarity !== undefined)
        .sort((a, b) => b.similarity! - a.similarity!)
        .forEach((c, index) => semanticRank.set(c.id, index + 1));
    }
    const relevanceOf = (c: ColdCandidate): number =>
      fusionApplied
        ? rrfScore(semanticRank.get(c.id), c.lexicalRank, migrationActive)
        : applyMigrationReweight(
            { vectorScore: c.similarity ?? 0, isFtsOnly: false },
            migrationActive
          );

    traceStage("fusion", candidates.size);

    const nowMs = Date.now();

    // A second kind for the same hit is a fallback lookup (see vectorHitKinds):
    // its failure must not fail the recall.
    const refs = [...candidates.values()].flatMap((candidate) =>
      vectorHitKinds(candidate.primitiveKind).map((kind, i) => ({
        id: candidate.id,
        kind,
        fallback: i > 0,
      }))
    );
    const batchStorage = ctx.storage as Partial<
      Pick<
        StorageAdapter,
        "getRecallPrimitives" | "getRecallLogs" | "getRecallStructures" | "getUnresolvedConflictIds"
      >
    >;
    const primitiveRecords = batchStorage.getRecallPrimitives
      ? await batchStorage
          .getRecallPrimitives(
            query.workspaceId,
            refs.map(({ id, kind }) => ({ id, kind }))
          )
          .catch((err: unknown) => {
            ctx.logger.warn("recall.batch_primitives_error", {
              err: err instanceof Error ? err.message : String(err),
            });
            return [];
          })
      : await Promise.all(
          refs.map(async (ref) => {
            const lookup = fetchView(ctx, ref.id, ref.kind, query.workspaceId);
            const view = ref.fallback ? await lookup.catch(() => null) : await lookup;
            return view ? { ref, view } : null;
          })
        );
    const viewByKey = new Map<string, PrimitiveView>();
    if (batchStorage.getRecallPrimitives) {
      for (const record of primitiveRecords as RecallPrimitiveRecord[]) {
        const view = viewRecallPrimitive(record);
        if (view) viewByKey.set(`${record.kind}:${record.id}`, view);
      }
    } else {
      for (const entry of primitiveRecords as Array<{
        ref: { id: string; kind: PrimitiveKind };
        view: PrimitiveView;
      } | null>) {
        if (entry) viewByKey.set(`${entry.ref.kind}:${entry.ref.id}`, entry.view);
      }
    }

    // Stages 3–6: eligibility and base score, before any per-hit I/O. Stale
    // vector/cache ids, closed rows, low worth, filters and the sensitivity
    // ceiling are all rejected here, so nothing downstream (activation reads,
    // graph lookups, logging, promotion) ever touches an ineligible candidate.
    const eligible: Array<{
      candidate: ColdCandidate;
      primitive: PrimitiveKind;
      view: PrimitiveView;
      baseScore: number;
      injectionScore: number;
    }> = [];
    for (const candidate of candidates.values()) {
      const primitive = vectorHitKinds(candidate.primitiveKind).find((kind) =>
        viewByKey.has(`${kind}:${candidate.id}`)
      );
      if (!primitive) continue;
      const view = viewByKey.get(`${primitive}:${candidate.id}`)!;
      if (query.asOf) {
        if (!heldAt(view, query.asOf)) continue;
      } else if (primitive === "fact") {
        if (
          !isRecallableFact(
            { status: view.factStatus ?? "active", validTo: view.validTo ?? undefined },
            query.includeArchived === true
          )
        )
          continue;
      } else if (
        view.lifecycle !== "active" &&
        !(query.includeArchived === true && view.lifecycle === "archived")
      )
        continue;

      // Worth serving gate (spec §11). Untested facts (never observed either
      // way) are exempt; see passesWorthGate() bugfix note in worth.ts.
      if (
        !query.includeLowWorth &&
        !passesWorthGate(
          { primitive, worth: view.worth, worthLowerBound: view.worthLowerBound },
          view.isUntested
        )
      )
        continue;
      if (
        !matchesRecallFilter(
          {
            primitive,
            tags: view.tags,
            validFrom: view.validFrom,
            validTo: view.validTo,
            worth: view.worth,
            confidence: view.confidence,
            sensitivity: view.sensitivity,
            provenance: view.provenance,
            entityId: view.entityId,
            entityIds: view.entityIds,
            sessionId: view.sessionId,
            scope: view.scope as RecallHit["scope"],
            scopeRef: view.scopeRef,
            actorId: view.actorId,
            scopeOwner: view.scopeOwner,
          },
          query.filter
        )
      )
        continue;
      if (!sensitivityAllowed(view.sensitivity, auth)) continue;

      // Stage 7 (scoring half): injection scoring + demotion (spec Wave X).
      const injection = scoreInjection(
        view.content,
        ctx.config?.injectionScoreThreshold ?? DEFAULT_INJECTION_THRESHOLD
      );
      const baseScore =
        relevanceOf(candidate) *
        candidate.kindWeight *
        worthFactor(view.worth) *
        (injection.flagged ? 1 - injection.score : 1);
      eligible.push({ candidate, primitive, view, baseScore, injectionScore: injection.score });
    }

    // §17 post-processing dedup, on EXACT content (CHAOS-11). The spec's
    // "cosine > 0.88" dropped distinct facts — "the budget alert is 2,000 USD"
    // and "… 3,500 USD" sit above it — and re-embedded every result set on
    // every recall. Applied before pagination so a dropped copy frees its slot.
    // Exact ties break by id, so the page does not depend on the order the
    // index returned equal-scoring rows (two identical recalls must agree).
    eligible.sort(
      (a, b) => b.baseScore - a.baseScore || compareIds(a.candidate.id, b.candidate.id)
    );
    traceStage("eligibility", candidates.size, eligible.length);
    const seenContent = new Set<string>();
    const distinct = eligible.filter(({ view }) => {
      const key = normalizedContent(view.content);
      if (seenContent.has(key)) return false;
      seenContent.add(key);
      return true;
    });
    traceStage("dedup", eligible.length, distinct.length);

    // RECALL-3: judged over every eligible candidate, before pagination.
    const nothingRelevant = isNothingRelevant(
      distinct.map((e) => e.candidate.similarity),
      relevanceFloor,
      distinct.length
    );
    // APP-020: once something clears the floor, a hit measured under it is noise
    // next to it, and a caller injecting the page could not tell the two apart
    // (RecallHit has no per-hit flag). Drop them before pagination. Kept when
    // nothing is relevant (the least-bad matches, flagged by `nothingRelevant`)
    // and when no cosine was measured (hybrid's lexical-only hits).
    const relevant =
      nothingRelevant || relevanceFloor === undefined
        ? distinct
        : distinct.filter(
            (e) => e.candidate.similarity === undefined || e.candidate.similarity >= relevanceFloor
          );

    // Stage 4: Petrov ACT-R activation A(t) = ln(∑ t_j^{-d}), d=0.5, read from
    // the recall log — now a bounded tie-breaker (×1–1.02, see
    // recall-relevance.ts). It cannot lift a candidate whose base score is
    // under the page's last one by more than that, so only those within
    // reach of the page need their history read.
    const pageEnd = offset + limit;
    const cutoff =
      relevant.length > pageEnd
        ? relevant[pageEnd - 1]!.baseScore / (1 + ACTIVATION_TIE_BREAK)
        : -Infinity;
    const contenders = relevant.filter((e) => e.baseScore >= cutoff);
    const contenderIds = contenders.map((e) => e.candidate.id);
    const historyById = new Map<string, number[]>();
    if (batchStorage.getRecallLogs) {
      const recallLogs = await batchStorage
        .getRecallLogs(query.workspaceId, contenderIds, 20)
        .catch(() => []);
      for (const entry of recallLogs) {
        const history = historyById.get(entry.memoryId) ?? [];
        history.push(new Date(entry.recalledAt).getTime());
        historyById.set(entry.memoryId, history);
      }
    } else if ("getRecallLog" in ctx.storage) {
      const storage = ctx.storage as {
        getRecallLog: (w: string, m: string, n: number) => Promise<Array<{ recalledAt: string }>>;
      };
      await Promise.all(
        contenderIds.map(async (id) => {
          const log = await storage.getRecallLog(query.workspaceId, id, 20).catch(() => []);
          historyById.set(
            id,
            log.map((e) => new Date(e.recalledAt).getTime())
          );
        })
      );
    }
    const page = contenders
      .map((e) => ({
        ...e,
        score:
          e.baseScore *
          activationFactor(petrovActivation(historyById.get(e.candidate.id) ?? [], nowMs)),
      }))
      .sort((a, b) => b.score - a.score || compareIds(a.candidate.id, b.candidate.id))
      .slice(offset, pageEnd);
    traceStage("activation", contenders.length, page.length);

    // Stage 3: graph context and dispute state, for the served page only —
    // neither affects the score, so the rest of the candidates never pay for
    // them. Hyperedges are HINTS (RECALL-2): their co-members are named on the
    // hit and never injected into the results at the trigger's score.
    const pageIds = page.map((e) => e.candidate.id);
    const [structures, conflictIds] = await Promise.all([
      batchStorage.getRecallStructures && pageIds.length > 0
        ? batchStorage
            .getRecallStructures(query.workspaceId, pageIds, 10, effectiveCeiling(auth))
            .catch(() => ({ relations: [], hyperedges: [] }))
        : Promise.resolve(null),
      batchStorage.getUnresolvedConflictIds && pageIds.length > 0
        ? batchStorage
            .getUnresolvedConflictIds(query.workspaceId, pageIds, effectiveCeiling(auth))
            .then((ids) => new Set(ids))
            .catch(() => new Set<string>())
        : Promise.resolve(new Set<string>()),
    ]);
    const relationsById = new Map<string, RecallHit["relations"]>();
    const hyperedgesById = new Map<string, NonNullable<RecallHit["hyperedges"]>>();
    if (structures) {
      for (const relation of structures.relations) {
        // A closed relation (resolved conflict, unlinked, superseded) is history,
        // not context for what is served now; a point-in-time recall wants the
        // relations that held at its instant.
        if (query.asOf ? !heldAt(relation, query.asOf) : relation.validTo != null) continue;
        const relations = relationsById.get(relation.sourceId) ?? [];
        relations.push({
          id: relation.id,
          targetId: relation.targetId,
          targetKind: relation.targetType as PrimitiveKind,
          verb: relation.verb,
          weight: relation.weight ?? 1,
        });
        relationsById.set(relation.sourceId, relations);
      }
      for (const { memberId, hyperedge } of structures.hyperedges) {
        const entries = hyperedgesById.get(memberId) ?? [];
        entries.push({
          id: hyperedge.id,
          coMembers: hyperedge.memberIds.filter((id) => id !== memberId),
          label: hyperedge.label,
          worth: hyperedge.worth,
        });
        hyperedgesById.set(memberId, entries);
      }
    }

    // Stage 7: assemble RecallHit[] with structured security labels.
    const served: RecallHit[] = await Promise.all(
      page.map(async ({ candidate, primitive, view, score, injectionScore }) => {
        const id = candidate.id;
        const relations = structures
          ? (relationsById.get(id) ?? [])
          : (
              await ctx.storage
                .getRelations({
                  workspaceId: query.workspaceId,
                  sourceId: id,
                  maxSensitivity: effectiveCeiling(auth),
                })
                .catch(() => [])
            )
              .filter((relation) =>
                query.asOf ? heldAt(relation, query.asOf) : relation.validTo == null
              )
              .map((relation) => ({
                id: relation.id,
                targetId: relation.targetId,
                targetKind: relation.targetType as PrimitiveKind,
                verb: relation.verb,
                weight: relation.weight ?? 1,
              }));
        let hyperedges = hyperedgesById.get(id) ?? [];
        if (!structures) {
          const hyperedgesPage = await ctx.storage
            .queryHyperedges({
              workspaceId: query.workspaceId,
              memberId: id,
              limit: 10,
              maxSensitivity: effectiveCeiling(auth),
            })
            .catch(() => ({
              items: [] as Awaited<ReturnType<typeof ctx.storage.queryHyperedges>>["items"],
            }));
          hyperedges = hyperedgesPage.items.map((h) => ({
            id: h.id,
            coMembers: h.memberIds.filter((m) => m !== id),
            label: h.label,
            worth: h.worth,
          }));
        }
        const status = hitStatus(view, conflictIds.has(id));
        return {
          id,
          primitive,
          content: view.content,
          score,
          ...(candidate.similarity !== undefined ? { similarity: candidate.similarity } : {}),
          // Stage 7: Structured security labels — never interpolated inline
          sensitivity: view.sensitivity,
          injectionScore,
          provenance: view.provenance ?? "user_stated",
          origin: "local",
          contested: status === "contested",
          status,
          validFrom: view.validFrom,
          validTo: view.validTo,
          tags: view.tags,
          relations,
          hyperedges,
          // Wave H: populate worth + factKind for compositionality engine matching
          worth: view.worth ?? 0.5,
          worthLowerBound: primitive === "fact" ? view.worthLowerBound : undefined,
          factKind: primitive === "fact" ? view.factKind : undefined,
          ...(view.scope ? { scope: view.scope as RecallHit["scope"] } : {}),
          ...(view.scopeRef ? { scopeRef: view.scopeRef } : {}),
          ...(view.scopeOwner ? { scopeOwner: view.scopeOwner } : {}),
          ...(view.topicKey ? { topicKey: view.topicKey } : {}),
          ...(view.subject ? { subject: view.subject } : {}),
          // P11 — include actorId in hit (null = pre-attribution era)
          actorId: view.actorId ?? null,
          userId: view.userId ?? null,
          ...(view.actorType ? { actorType: view.actorType } : {}),
        } satisfies RecallHit;
      })
    );

    traceStage("graph", page.length, served.length);

    // Synthetic traffic retrieves but must not train the organic corpus:
    // hyperedge_bump feeds activationCount, which orders later structures.
    const bumpedHyperedgeIds = new Set<string>();
    for (const hit of runEffects ? served : []) {
      for (const hyperedge of hit.hyperedges ?? []) {
        if (bumpedHyperedgeIds.has(hyperedge.id)) continue;
        bumpedHyperedgeIds.add(hyperedge.id);
        void ctx.outbox
          .append({
            workspaceId: query.workspaceId,
            eventType: "hyperedge_bump",
            payload: { hyperedgeId: hyperedge.id },
          })
          .catch(() => undefined);
      }
    }

    // Post-recall composition hook (Wave H3).
    // Runs on cold-path only — NOT on hot-tier hits (see STATUS PARTIAL caveat).
    let inferences: DerivedInference[] = [];
    if (runEffects && served.length > 0) {
      const compSpan = ctx.telemetry.startSpan(MNEMO_SPAN_NAMES.composition, { parent: span });
      try {
        inferences = await composeInferences(ctx, query.workspaceId, served, {
          materialise: query.materialiseInferences === true,
          ...(query.text ? { triggeredByQuery: query.text } : {}),
          ...(query.conversationId ? { conversationId: query.conversationId } : {}),
        }).catch((err) => {
          ctx.logger.warn("recall.compose_failed", {
            error: { type: "compose_failed", message: String(err) },
          });
          return [] as DerivedInference[];
        });
        compSpan.setAttribute("mnemo.firings", inferences.length);
      } finally {
        compSpan.end();
      }
    }

    // RecMem gate input (spec §1/§2, MEMORY_IMPROVEMENT.md:140, :1374).
    // maybeRerank computes the recurrence signal from hit embeddings; the
    // VectorSearchHit/RecallHit shapes do NOT carry embeddings, so without this
    // step recurrenceSignal([]) === 1.0 and the gate could never skip. We embed
    // the served contents in ONE batch ONLY when rerank is requested, so the
    // common rerank=false path pays nothing. Embedding failures degrade to the
    // unchanged set (gate then sees [] → does not skip → safe default).
    if (
      query.rerank === true &&
      served.length > 0 &&
      (sensitiveTextMayReachEmbedder(ctx.config?.sensitiveTextToProviders, ctx.embed) ||
        !served.some((h) => isSensitiveTier(h.sensitivity)))
    ) {
      try {
        const vecs = await ctx.embed.embed(served.map((h) => h.content));
        if (vecs.length === served.length) {
          for (let i = 0; i < served.length; i++) {
            served[i]!.embedding = Array.from(vecs[i]!);
          }
        }
      } catch (err) {
        ctx.logger.debug("recall.recmem_embed_failed", {
          operation: "recall.recmem",
          error: { type: "recmem_embed_failed", message: String(err) },
        });
      }
    }

    const rerankSpan = ctx.telemetry.startSpan(MNEMO_SPAN_NAMES.rerank, { parent: span });
    let finalHits: RecallHit[];
    const rerankOutcome: { degraded?: boolean } = {};
    try {
      finalHits = await maybeRerank(ctx, query, served, rerankOutcome);
      rerankSpan.setAttribute("mnemo.hit_count", finalHits.length);
    } finally {
      rerankSpan.end();
    }

    traceStage("rerank", served.length, finalHits.length);

    // A look at the past is not use: a point-in-time recall moves no worth,
    // no activation, no graph learning and no hot-tier entry.
    const servedFacts = query.asOf ? [] : finalHits.filter((h) => h.primitive === "fact");

    // §15 / "Predictive Memory" pattern 4: learning graph structure from
    // retrieval alone — `related` relations between co-recalled facts and
    // Hebbian hyperedges after three co-recalls. OFF unless the host opts in
    // (`recallGraphLearning`): being served together is not evidence that two
    // facts belong together. An agent recalling one broad query three times
    // formed hyperedges and 1,064 `related` rows in an hour (RECALL-11,
    // AGENTSIM-14). Rows already written are left alone.
    if (runEffects && ctx.config?.recallGraphLearning === true && servedFacts.length > 0) {
      void recordCoRecall(
        ctx.storage,
        query.workspaceId,
        servedFacts.map((h) => h.id),
        nowMs,
        ctx.onCoRecallTail
      ).catch(() => undefined);
      void maybeFormHebbianHyperedge(ctx, query.workspaceId, servedFacts).catch((err) => {
        ctx.logger.debug("recall.hebbian_formation_failed", {
          error: { type: "hebbian_formation_failed", message: String(err) },
        });
      });
    }

    // Spec §17: promote up to top-3 served facts to the hot tier (async, non-blocking).
    void Promise.allSettled(
      (runEffects ? servedFacts : [])
        .slice(0, 3)
        .map((h) => coldBumpHotTier(ctx, query.workspaceId, h.id))
    );

    traceStage("response", finalHits.length);
    return buildResponse(
      finalHits,
      query.text,
      limit,
      offset,
      startMs,
      false,
      inferences,
      modeUsed,
      withTrace(
        rerankOutcome.degraded ? { ...debugMetadata, rerankDegraded: true } : debugMetadata
      ),
      nothingRelevant
    );
  } finally {
    ctx.telemetry.histogram("mnemo_recall_duration_seconds", (Date.now() - startMs) / 1000, {
      tier: "cold",
    });
    span.end();
  }
}

// ─── Prefer source episode (spec §17 lines 1101-1104) ────────────────────────

/**
 * For each fact hit that carries a `episodeId`, look up the source episode.
 * If found and sensitivity-allowed, inject it as a RecallHit at the fact's own
 * score, then demote the fact just below it so the richer context surfaces
 * first. The episode inherits the fact's relevance and no more: a former
 * "structural floor" of 0.5 lifted a fact at cosine 0.14 and its episode to
 * the top of an unrelated query.
 *
 * Spec §17 lines 1101-1104: "prefer source episode".
 * Best-effort: storage miss or absent getEpisode method → silent no-op.
 * Does NOT drop the fact; spec prefers, not replaces.
 */
export async function preferSourceEpisode(
  ctx: CoreContext,
  workspaceId: string,
  hits: RecallHit[],
  auth: AuthContext,
  filter?: RecallQuery["filter"],
  includeArchived = false,
  hydratedFacts?: ReadonlyMap<string, MnemoFact>
): Promise<RecallHit[]> {
  // Guard: storage adapter must expose getEpisode
  if (typeof ctx.storage.getEpisode !== "function") return hits;

  const existingIds = new Set(hits.map((h) => h.id));
  const toInject: RecallHit[] = [];
  // Track which fact ids need demotion (mapped to the episode score that beats them)
  const demotions = new Map<string, number>();

  const batchStorage = ctx.storage as Partial<Pick<StorageAdapter, "getRecallPrimitives">>;
  const sourceFacts =
    hydratedFacts ??
    new Map(
      (batchStorage.getRecallPrimitives
        ? await batchStorage.getRecallPrimitives(
            workspaceId,
            hits
              .filter((hit) => hit.primitive === "fact")
              .map((hit) => ({ id: hit.id, kind: "fact" as const }))
          )
        : []
      ).map((record) => [record.id, record.value as MnemoFact])
    );
  const episodeIds = new Set<string>();
  for (const hit of hits) {
    if (hit.primitive === "fact") {
      const fact = sourceFacts.get(hit.id);
      if (fact?.episodeId) episodeIds.add(fact.episodeId);
    }
  }
  const episodes =
    batchStorage.getRecallPrimitives && episodeIds.size > 0
      ? await batchStorage.getRecallPrimitives(
          workspaceId,
          [...episodeIds].map((id) => ({ id, kind: "episode" as const }))
        )
      : [];
  const episodesById = new Map(episodes.map((record) => [record.id, record.value as MnemoEpisode]));

  for (const hit of hits) {
    if (hit.primitive !== "fact") continue;

    // Fetch the raw fact to read MnemoFact.episodeId
    const fact =
      sourceFacts.get(hit.id) ??
      (batchStorage.getRecallPrimitives
        ? null
        : await ctx.storage.getFact(hit.id, workspaceId).catch(() => null));
    if (!fact?.episodeId) continue;

    const epId = fact.episodeId;

    // Already in result set — still demote the fact but no injection needed
    if (existingIds.has(epId)) {
      const existing = hits.find((h) => h.id === epId);
      if (existing && existing.score <= hit.score) {
        // Episode is present but ranked below the fact — demote the fact only
        demotions.set(hit.id, existing.score - 0.0001);
      }
      continue;
    }

    const ep =
      episodesById.get(epId) ??
      (batchStorage.getRecallPrimitives
        ? null
        : await ctx.storage.getEpisode(epId, workspaceId).catch(() => null));
    if (!ep) continue;

    const view = viewEpisode(ep);
    if (view.lifecycle !== "active" && !(includeArchived && view.lifecycle === "archived"))
      continue;
    if (!matchesRecallFilter({ primitive: "episode", ...view }, filter)) continue;
    if (!sensitivityAllowed(view.sensitivity, auth)) continue;

    const episodeScore = hit.score;
    toInject.push({
      id: ep.id,
      primitive: "episode",
      content: view.content,
      score: episodeScore,
      sensitivity: view.sensitivity,
      injectionScore: 0,
      provenance: view.provenance ?? "user_stated",
      origin: "local",
      contested: false,
      validFrom: view.validFrom,
      validTo: view.validTo,
      tags: view.tags,
      relations: [],
    });
    existingIds.add(epId);

    // Demote the fact to just below the injected episode
    demotions.set(hit.id, episodeScore - 0.0001);
  }

  if (toInject.length === 0 && demotions.size === 0) return hits;

  const result = hits.map((h) => {
    const demotedScore = demotions.get(h.id);
    return demotedScore !== undefined ? { ...h, score: demotedScore } : h;
  });

  return [...result, ...toInject];
}

// ─── Hyperedge member expansion (spec §15) ────────────────────────────────────

/**
 * Spec §15: pull co-members of high-worth hyperedges into the result set.
 * For each hit's hyperedges with worth > 0.5, fetch each co-member fact and
 * emit it as an additional RecallHit scored parentScore * hyperedge.worth.
 * Skips ids already present and any fact the sensitivity ceiling forbids.
 */
export async function expandHyperedgeMembers(
  ctx: CoreContext,
  workspaceId: string,
  hits: RecallHit[],
  auth: AuthContext,
  filter?: RecallQuery["filter"],
  options: Pick<RecallQuery, "includeArchived" | "includeLowWorth"> = {}
): Promise<RecallHit[]> {
  const present = new Set(hits.map((h) => h.id));
  const best = new Map<string, RecallHit>();

  for (const hit of hits) {
    for (const he of hit.hyperedges ?? []) {
      if ((he.worth ?? 0) <= 0.5) continue;
      for (const memberId of he.coMembers) {
        if (present.has(memberId)) continue;
        const f = await ctx.storage.getFact(memberId, workspaceId).catch(() => null);
        if (!f || !isRecallableFact(f, options.includeArchived === true)) continue;
        if (!matchesRecallFilter(f, filter)) continue;
        const sensitivity: Sensitivity = f.sensitivity ?? "internal";
        if (!sensitivityAllowed(sensitivity, auth)) continue;
        const worthLowerBound = worthGateLowerBound(f);
        const isUntested = isUntestedWorth(f);
        if (
          !options.includeLowWorth &&
          !passesWorthGate(
            {
              primitive: "fact",
              worth: f.worth,
              worthLowerBound,
            },
            isUntested
          )
        )
          continue;
        const rawScore = hit.score * (he.worth ?? 0);
        const memberInjection = scoreInjection(
          f.statement,
          ctx.config?.injectionScoreThreshold ?? DEFAULT_INJECTION_THRESHOLD
        );
        const score = memberInjection.flagged ? rawScore * (1 - memberInjection.score) : rawScore;
        const existing = best.get(memberId);
        if (existing && existing.score >= score) continue;
        best.set(memberId, {
          id: f.id,
          primitive: "fact" as const,
          content: f.statement,
          score,
          sensitivity,
          injectionScore: memberInjection.score,
          provenance: f.attribution as RecallHit["provenance"],
          origin: "local" as const,
          contested: false,
          validFrom: f.validFrom,
          validTo: f.validTo ?? null,
          tags: metadataTags(f.metadata),
          relations: [],
          worth: f.worth,
          worthLowerBound,
        });
      }
    }
  }
  return [...best.values()];
}

// ─── Post-processing dedup (spec §17) ─────────────────────────────────────────

// Spec MEMORY_MODEL.md §"Post-Processing": "Deduplicate (cosine > 0.88 within
// result set)". The earlier merge only deduped by id; two facts with distinct
// ids but near-identical meaning both survived. Embeddings are not carried on
// VectorSearchHit, so we embed the (small, ≤ limit) final content set once via
// the EmbedAdapter port and drop near-duplicates, keeping the higher-scored hit.
const DEDUP_COSINE = 0.88;

function cosineSim(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Drop near-duplicate hits (cosine > 0.88) from the final result set. Hits are
 * processed highest-score first, so the survivor of any near-duplicate cluster
 * is the strongest. Pure except for the single batch embed call; degrades to a
 * no-op (returns input unchanged) if embedding the set fails. Empty / single-hit
 * sets are returned untouched.
 */
export async function dedupByContent(ctx: CoreContext, hits: RecallHit[]): Promise<RecallHit[]> {
  if (hits.length < 2) return hits;
  const ordered = [...hits].sort((a, b) => b.score - a.score);
  // Egress (SECURITY.md §7): when confidential+ text may not reach the
  // embedder, those hits are kept as they are and only the others are compared.
  const sealed = sensitiveTextMayReachEmbedder(ctx.config?.sensitiveTextToProviders, ctx.embed)
    ? () => false
    : (h: RecallHit) => isSensitiveTier(h.sensitivity);
  const comparable = ordered.filter((h) => !sealed(h));
  if (comparable.length < 2) return hits;
  let embeddings: Float32Array[];
  try {
    embeddings = await ctx.embed.embed(comparable.map((h) => h.content));
  } catch {
    return hits; // can't compare without vectors — keep deterministic order
  }
  if (embeddings.length !== comparable.length) return hits;
  const embeddingOf = new Map(comparable.map((h, i) => [h, embeddings[i]!]));

  const kept: RecallHit[] = [];
  const keptEmbeddings: Float32Array[] = [];
  for (let i = 0; i < ordered.length; i++) {
    const emb = embeddingOf.get(ordered[i]!);
    if (!emb) {
      kept.push(ordered[i]!);
      continue;
    }
    const isDuplicate = keptEmbeddings.some((k) => cosineSim(k, emb) > DEDUP_COSINE);
    if (isDuplicate) continue;
    kept.push(ordered[i]!);
    keptEmbeddings.push(emb);
  }
  return kept;
}

// ─── Automatic Hebbian hyperedge formation (spec §15) ─────────────────────────

// Spec MEMORY_MODEL.md §"Hyperedge formation":
//   "Automatic: When ≥3 facts are consistently co-recalled (Hebbian)".
// "Consistently" ⇒ an established co-recall history, not a single co-occurrence:
// we require each member to have co_recall_count ≥ this floor with the anchor.
const HEBBIAN_MIN_MEMBERS = 3;
const HEBBIAN_CONSISTENT_CORECALL = 3;

/**
 * Form a hyperedge from ≥3 consistently co-recalled facts.
 *
 * Reads `mnemo_relation.co_recall_count` (via getCoOccurrencePatterns) to find,
 * among the facts just served together, an anchor whose co-recall partners —
 * also present in this result set, each with co_recall_count ≥ 3 — number ≥ 2.
 * Anchor + partners = ≥3 members ⇒ a stable n-ary cluster. Skips creation if an
 * existing hyperedge already covers that exact member set (idempotent).
 *
 * Uses ONLY existing StorageAdapter port methods (getCoOccurrencePatterns,
 * queryHyperedges, createHyperedge). Pure-ish: best-effort, returns the created
 * hyperedge id or null; the caller invokes it fire-and-forget so it never blocks
 * or fails a recall.
 */
export async function maybeFormHebbianHyperedge(
  ctx: CoreContext,
  workspaceId: string,
  served: RecallHit[]
): Promise<string | null> {
  // Only facts participate in Hebbian hyperedges (co_recall_count is fact-keyed).
  const factHits = served.filter((h) => h.primitive === "fact");
  if (factHits.length < HEBBIAN_MIN_MEMBERS) return null;
  if (!ctx.storage.getCoOccurrencePatterns || !ctx.storage.createHyperedge) return null;

  const servedIds = new Set(factHits.map((h) => h.id));
  // Anchor on the strongest served fact (factHits arrive score-sorted).
  const anchor = factHits[0]!;

  const partners = await ctx.storage
    .getCoOccurrencePatterns({
      workspaceId,
      sourceId: anchor.id,
      minCoRecall: HEBBIAN_CONSISTENT_CORECALL,
      limit: 50,
    })
    .catch(() => []);

  // Keep only co-recall partners that were ALSO served in this same event —
  // they are the facts demonstrably co-recalled together right now.
  const coMemberIds = partners
    .map((p) => p.partnerId)
    .filter((id) => servedIds.has(id) && id !== anchor.id);

  const memberIds = [anchor.id, ...new Set(coMemberIds)];
  if (memberIds.length < HEBBIAN_MIN_MEMBERS) return null;

  // Idempotency: skip if a hyperedge whose member set is a superset of ours
  // already exists (any existing hyperedge on the anchor covering these members).
  if (ctx.storage.queryHyperedges) {
    const existing = await ctx.storage
      .queryHyperedges({ workspaceId, memberId: anchor.id, limit: 50 })
      .catch(() => ({
        items: [] as Awaited<ReturnType<NonNullable<typeof ctx.storage.queryHyperedges>>>["items"],
      }));
    const memberSet = new Set(memberIds);
    const alreadyCovered = existing.items.some((h) => {
      const hMembers = new Set(h.memberIds);
      return [...memberSet].every((m) => hMembers.has(m));
    });
    if (alreadyCovered) return null;
  }

  const created = await ctx.storage.createHyperedge({
    workspaceId,
    memberIds,
    label: "co-recalled",
    description: `Auto-formed from ${memberIds.length} consistently co-recalled facts (Hebbian, spec §15).`,
  });
  ctx.logger.info("recall.hebbian_hyperedge_formed", {
    workspaceId,
    hyperedgeId: created.id,
    memberCount: memberIds.length,
  });
  return created.id;
}

// ─── Response builder ─────────────────────────────────────────────────────────

function buildResponse(
  hits: RecallHit[],
  text: string,
  limit: number,
  offset: number,
  startMs: number,
  fromHotTier: boolean,
  inferences: DerivedInference[] = [],
  searchMode?: "vector" | "fts" | "lexical" | "semantic" | "hybrid" | "auto",
  debug?: RecallResponse["debug"],
  // WP-3 (RECALL-3): callers that judged relevance pass it; elsewhere (hot,
  // pointer and L3 tiers, which only answer on strong evidence) an empty
  // result is the only "nothing relevant" this builder can vouch for.
  nothingRelevant?: boolean
): RecallResponse {
  // topicKey-suggest-and-hit-freshness slice (c) — capture "now" once so
  // every hit in this response is bucketed against the same instant
  // (avoids drift across a large hit list, and keeps stamping deterministic
  // for a given call).
  const nowMs = Date.now();
  const stampedHits = hits.map((hit) => ({
    ...hit,
    hitFreshness: hitFreshness(hit.validFrom, nowMs),
  }));
  return {
    hits: stampedHits,
    total: stampedHits.length,
    query: { text, limit, offset },
    latencyMs: Date.now() - startMs,
    fromHotTier,
    nothingRelevant: nothingRelevant ?? stampedHits.length === 0,
    inferences: inferences.length > 0 ? inferences : undefined,
    ...(searchMode !== undefined ? { searchMode } : {}),
    ...(debug !== undefined ? { debug } : {}),
  };
}

// Export builder so hot-tier can use the same response shape
export { buildResponse };

// ─── FTS-only fallback (no embed adapter) ─────────────────────────────────────

/**
 * Full-text search recall for when the embed adapter is not configured
 * (MNEMO_LLM_API_KEY absent). Uses the text_lemmatized GENERATED ALWAYS tsvector
 * column (migration 0047 / idx_fact_fts) via the storage adapter's ftsCandidates
 * port method.
 *
 * Splits query.text into whitespace-separated terms and passes them to
 * ftsCandidates which issues:
 *   SELECT id, statement, ... FROM mnemo_fact
 *   WHERE text_lemmatized @@ plainto_tsquery(mnemosyne.mnemo_fts, $1) ...
 *   ORDER BY ts_rank(text_lemmatized, ...) DESC
 *
 * Fact FTS and non-fact lexical candidates are queried independently. If an
 * adapter lacks either optional port, that arm returns no candidates.
 *
 * Security: each candidate still passes through the sensitivityAllowed ceiling
 * so restricted facts are never leaked regardless of search mode.
 */
export async function ftsFallbackRecall(
  ctx: CoreContext,
  query: RecallQuery,
  auth: AuthContext
): Promise<RecallHit[]> {
  return (await lexicalRecall(ctx, query, auth)).hits;
}

/**
 * A failed lexical query degrades to "no lexical candidates", which is
 * indistinguishable from a query that matched nothing unless it is logged.
 */
function logLexicalFailure(ctx: CoreContext, workspaceId: string, err: unknown): void {
  ctx.logger.warn("recall.fts_failed", {
    workspaceId,
    error: {
      type: err instanceof Error ? err.name : "Error",
      message: err instanceof Error ? err.message : String(err),
    },
  });
}

async function lexicalRecall(
  ctx: CoreContext,
  query: RecallQuery,
  auth: AuthContext
): Promise<{
  hits: RecallHit[];
  candidateCount: number;
  ftsFailed: boolean;
  nothingRelevant: boolean;
}> {
  const empty = {
    hits: [] as RecallHit[],
    candidateCount: 0,
    ftsFailed: false,
    nothingRelevant: true,
  };

  const terms = query.text.split(/\s+/).filter((t) => t.length > 0);
  if (terms.length === 0) return empty;

  const limit = query.limit ?? 10;
  const offset = query.offset ?? 0;

  let ftsFailed = false;
  const candidates =
    (await ctx.storage
      .ftsCandidates?.({
        workspaceId: query.workspaceId,
        terms,
        limit: Math.min(1000, Math.max(limit + offset, (limit + offset) * 5)),
        filter: recallFilterForAuth(query.filter, auth),
        includeArchived: query.includeArchived,
        includeLowWorth: query.includeLowWorth ?? false,
        relaxedOnEmpty: true,
        ...(query.asOf ? { asOf: query.asOf } : {}),
      })
      .catch((err: unknown) => {
        ftsFailed = true;
        logLexicalFailure(ctx, query.workspaceId, err);
        return [];
      })) ?? [];

  const hits: RecallHit[] = [];
  for (const cand of candidates) {
    if (
      query.asOf
        ? !heldAt(
            { validFrom: cand.validFrom ?? cand.createdAt, validTo: cand.validTo },
            query.asOf
          )
        : !isRecallableFact(cand, query.includeArchived === true)
    )
      continue;
    if (
      !matchesRecallFilter(
        {
          primitive: "fact",
          tags: cand.tags ?? [],
          validFrom: cand.validFrom ?? cand.createdAt,
          validTo: cand.validTo,
          worth: cand.worth,
          confidence: cand.confidence,
          sensitivity: cand.sensitivity,
          provenance: cand.attribution,
          entityId: cand.entityId,
          sessionId: cand.sessionId,
          scope: cand.scope,
          scopeRef: cand.scopeRef,
          actorId: cand.actorId,
          scopeOwner: cand.scopeOwner,
        },
        query.filter
      )
    )
      continue;
    const sensitivity = cand.sensitivity ?? "internal";
    if (!sensitivityAllowed(sensitivity, auth)) continue;

    // Use ts_rank-derived ordering: ftsCandidates returns rows ordered by
    // ts_rank DESC, so the rank itself is the relevance; worth is only the
    // bounded prior every other path applies (recall-relevance.ts).
    const worth = cand.worth ?? 0.5;
    const worthLowerBound = worthGateLowerBound(cand);
    const isUntested = isUntestedWorth(cand);
    if (
      !query.includeLowWorth &&
      !passesWorthGate(
        {
          primitive: "fact",
          worth,
          worthLowerBound,
        },
        isUntested
      )
    )
      continue;
    const rankScore = cand.rank * worthFactor(worth);

    const injection = scoreInjection(
      cand.statement,
      ctx.config?.injectionScoreThreshold ?? DEFAULT_INJECTION_THRESHOLD
    );
    const score = injection.flagged ? rankScore * (1 - injection.score) : rankScore;

    const closed = cand.validTo != null;
    hits.push({
      id: cand.factId,
      primitive: "fact",
      content: cand.statement,
      score,
      sensitivity,
      injectionScore: injection.score,
      provenance: (cand.attribution ?? "user_stated") as Provenance,
      origin: "local",
      contested: false,
      ...(closed ? { status: "superseded" as const } : {}),
      validFrom: cand.validFrom ?? cand.createdAt,
      validTo: cand.validTo ?? null,
      tags: cand.tags ?? [],
      relations: [],
      worth,
      worthLowerBound,
      ...(cand.scope ? { scope: cand.scope } : {}),
      actorId: cand.actorId ?? null,
      userId: cand.userId ?? null,
      ...(cand.actorType ? { actorType: cand.actorType } : {}),
      ...(cand.scopeRef ? { scopeRef: cand.scopeRef } : {}),
      ...(cand.scopeOwner ? { scopeOwner: cand.scopeOwner } : {}),
      ...(cand.topicKey ? { topicKey: cand.topicKey } : {}),
      ...(cand.subject ? { subject: cand.subject } : {}),
    });
  }

  const kinds = RECALLABLE_KINDS.filter(
    (kind) => kind !== "fact" && (query.filter?.kinds ?? DEFAULT_RECALL_KINDS).includes(kind)
  );
  let decisionRows: PrimitiveCandidate[] = [];
  if (kinds.length > 0 && ctx.storage.recallableCandidates) {
    decisionRows = await ctx.storage
      .recallableCandidates({
        workspaceId: query.workspaceId,
        kinds,
        terms,
        // RECALL-7: the same strict-then-relaxed matching the fact arm uses.
        relaxedOnEmpty: true,
        // Filters, sensitivity and worth are applied after hydration, not in
        // the query, so a request-sized window could be emptied by rejects.
        limit: 1000,
        ...(query.filter?.scopeOwner ? { scopeOwner: query.filter.scopeOwner } : {}),
        ...(query.asOf ? { asOf: query.asOf } : {}),
      })
      .catch((err: unknown) => {
        ftsFailed = true;
        logLexicalFailure(ctx, query.workspaceId, err);
        return [];
      });
  }
  // RECALL-10: one batched hydration instead of one round-trip per row.
  const batchStorage = ctx.storage as Partial<Pick<StorageAdapter, "getRecallPrimitives">>;
  const views = new Map<string, PrimitiveView>();
  if (batchStorage.getRecallPrimitives && decisionRows.length > 0) {
    const records = await batchStorage
      .getRecallPrimitives(
        query.workspaceId,
        decisionRows.map((row) => ({
          id: row.id,
          kind: row.kind as RecallPrimitiveRef["kind"],
        }))
      )
      .catch(() => [] as RecallPrimitiveRecord[]);
    for (const record of records) {
      const view = viewRecallPrimitive(record);
      if (view) views.set(record.id, view);
    }
  } else {
    for (const row of decisionRows) {
      const view = await fetchView(ctx, row.id, row.kind, query.workspaceId);
      if (view) views.set(row.id, view);
    }
  }
  for (const row of decisionRows) {
    const view = views.get(row.id);
    if (
      !view ||
      (query.asOf
        ? !heldAt(view, query.asOf)
        : view.lifecycle !== "active" && !(query.includeArchived && view.lifecycle === "archived"))
    )
      continue;
    if (!sensitivityAllowed(view.sensitivity, auth)) continue;
    if (
      !matchesRecallFilter(
        {
          primitive: row.kind,
          tags: view.tags,
          validFrom: view.validFrom,
          validTo: view.validTo,
          worth: view.worth,
          confidence: view.confidence,
          sensitivity: view.sensitivity,
          provenance: view.provenance,
          entityId: view.entityId,
          entityIds: view.entityIds,
          sessionId: view.sessionId,
          scope: view.scope,
          scopeRef: view.scopeRef,
          actorId: view.actorId,
          scopeOwner: view.scopeOwner,
        },
        query.filter
      )
    )
      continue;
    if (
      !query.includeLowWorth &&
      !passesWorthGate(
        { primitive: row.kind, worth: view.worth, worthLowerBound: view.worthLowerBound },
        view.isUntested
      )
    )
      continue;
    const injection = scoreInjection(
      view.content,
      ctx.config?.injectionScoreThreshold ?? DEFAULT_INJECTION_THRESHOLD
    );
    // RECALL-4: the same rule as facts — rank × worth prior, no ×0.85 damping.
    const score =
      (row.lexicalRank ?? row.score) *
      worthFactor(view.worth) *
      (injection.flagged ? 1 - injection.score : 1);
    hits.push({
      id: row.id,
      primitive: row.kind,
      content: view.content,
      score,
      sensitivity: view.sensitivity,
      injectionScore: injection.score,
      provenance: view.provenance ?? "user_stated",
      origin: "local",
      contested: false,
      ...(view.lifecycle !== "active" ? { status: "superseded" as const } : {}),
      validFrom: view.validFrom,
      validTo: view.validTo,
      tags: view.tags,
      relations: [],
      worth: view.worth ?? 0.5,
      ...(view.scopeRef ? { scopeRef: view.scopeRef } : {}),
      ...(view.scopeOwner ? { scopeOwner: view.scopeOwner } : {}),
      ...(view.topicKey ? { topicKey: view.topicKey } : {}),
      actorId: view.actorId ?? null,
      userId: view.userId ?? null,
    });
  }

  // Stable sort by score descending, exact-content dedup (CHAOS-11), then paginate
  hits.sort((a, b) => b.score - a.score || compareIds(a.id, b.id));
  const seenContent = new Set<string>();
  const distinct = hits.filter((hit) => {
    const key = normalizedContent(hit.content);
    if (seenContent.has(key)) return false;
    seenContent.add(key);
    return true;
  });
  const page = distinct.slice(offset, offset + limit);
  // AGENTSIM-4: dispute state for the served page.
  await stampHitStatus(ctx, query.workspaceId, page, auth);
  return {
    hits: page,
    candidateCount: candidates.length + decisionRows.length,
    ftsFailed,
    // A lexical search measures no cosine: the only "nothing" it can vouch
    // for is having matched nothing at all.
    nothingRelevant: distinct.length === 0,
  };
}

/**
 * RecMem-gated optional LLM rerank (spec MEMORY_IMPROVEMENT.md:140, :561).
 * No-op unless ctx.llm exists, query.rerank===true, and query text is present.
 * Even then, the LLM call is SKIPPED when hits are thematically scattered (recurrence
 * signal < threshold) — returning the deterministic order unchanged. This makes
 * the LLM call a measurable, gated cost, not an unconditional one.
 */
/**
 * Upper bound on the rerank LLM call. Kept under the server's 5 s storage-read
 * breaker that wraps the whole recall: a busy model must degrade the ranking,
 * not time the request out (V-1).
 */
export const RERANK_TIMEOUT_MS = 3_000;

export async function maybeRerank<
  T extends {
    id: string;
    content: string;
    score: number;
    embedding?: number[];
    sensitivity?: Sensitivity;
  },
>(
  ctx: CoreContext,
  query: { text?: string; rerank?: boolean; recurrenceThreshold?: number },
  hits: T[],
  /** Set `degraded` when the LLM step failed or timed out and the input order stands. */
  outcome?: { degraded?: boolean }
): Promise<T[]> {
  if (!query.rerank || !query.text?.trim() || !ctx.llm || hits.length < 2) return hits;
  // Egress: the prompt carries every hit's text to the LLM provider, and
  // confidential+ text is decrypted on read. Unless the policy or a local
  // provider allows it, such a page keeps its score order (SECURITY.md §7).
  // A hit with no tier counts as sensitive: fail closed.
  if (
    hits.some((h) => isSensitiveTier(h.sensitivity)) &&
    !sensitiveTextMayReachLlm(ctx.config?.sensitiveTextToProviders, ctx.llm, "judge")
  )
    return hits;

  const embeddings = hits.map((h) => h.embedding ?? []).filter((e) => e.length > 0);
  // Estimate the prompt we would otherwise send (hit contents).
  const wouldBePromptChars = hits.reduce((n, h) => n + h.content.length, 0);
  const decision = decideRecmem(embeddings, {
    recurrenceThreshold: query.recurrenceThreshold ?? 0.6,
    skipLlmIfBelowThreshold: true,
    wouldBePromptChars,
  });

  if (decision.skipped) {
    ctx.logger.debug("recall: rerank skipped — low recurrence signal", {
      operation: "recall.recmem",
      signal: decision.signal,
      threshold: decision.threshold,
      estimatedTokensSaved: decision.estimatedTokensSaved,
    });
    return hits;
  }

  // High-signal: spend one LLM call to reorder by judged relevance.
  try {
    const prompt = [
      "Reorder these memory hits from most to least relevant to the query. Return a JSON array",
      "of their ids in the new order, nothing else.",
      "",
      `Query: ${query.text}`,
      "",
      ...hits.map((h, i) => `${i}. id=${h.id}: ${h.content}`),
    ].join("\n");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const out = await Promise.race([
      ctx.llm.generate({
        messages: [{ role: "user", content: prompt }],
        maxTokens: 256,
        temperature: 0,
        task: "judge",
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`rerank LLM timed out after ${RERANK_TIMEOUT_MS}ms`)),
          RERANK_TIMEOUT_MS
        );
      }),
    ]).finally(() => clearTimeout(timer));
    // Report token + cost usage to the host's metrics layer (completion path).
    // Fire-and-forget: a metrics failure must never break recall reranking.
    reportLlmUsage(
      ctx,
      ctx.llm.id,
      out.model,
      out.tokensUsed.input,
      out.tokensUsed.output,
      out.costUSD
    );
    // P124: the worst of the four to leave broken — a fenced reply here throws
    // into the surrounding catch and the rerank degrades SILENTLY, so recall
    // quietly returns the unreranked order and nobody is told.
    const order = parseJsonReply<string[]>(out.content, "recall.rerank");
    const byId = new Map(hits.map((h) => [h.id, h]));
    const reordered = order.map((id) => byId.get(id)).filter((h): h is T => h != null);
    // Append any hits the LLM dropped, preserving deterministic order.
    for (const h of hits) if (!order.includes(h.id)) reordered.push(h);
    return reordered.length === hits.length ? reordered : hits;
  } catch (err) {
    if (outcome) outcome.degraded = true;
    ctx.logger.warn?.("recall: rerank degraded to the un-reranked order", {
      operation: "recall.rerank",
      error: { type: "rerank_failed", message: String(err) },
    });
    return hits; // graceful degradation — deterministic order stands
  }
}
