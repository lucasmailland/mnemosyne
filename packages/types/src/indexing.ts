// Recallable-kind registry — the single source of truth for which primitive
// kinds are indexed on write (embedding + vector-index entry) and therefore
// retrievable through memory_recall / memory_search, and exactly what text
// is projected into that index for each kind.
//
// make-primitives-recallable (design.md D1), extended by P65: nine kinds are
// recallable today — every primitive except `entity`, which has its own
// cosine arm (findSimilarEntities) outside this registry. A default recall
// reaches seven kinds (DEFAULT_RECALL_KINDS plus entities); `kinds` reaches
// all ten. Adding a kind is a RECALLABLE_KINDS entry, a
// PRIMITIVE_TEXT_PROJECTION entry, its embedding/text_lemmatized columns, a
// DEFAULT_RECALL_KINDS decision and a backfill run.
//
// Zero infrastructure imports — enforced by `__tests__/purity.test.ts`.

import type { PrimitiveKind } from "./primitives.js";

/**
 * Primitive kinds whose write path is guaranteed to produce a `vector_upsert`
 * outbox entry in the same transaction that persists the row (spec.md
 * Requirement 1). A kind NOT in this set is persisted but never indexed —
 * "write-only memory", the exact defect this change fixes for `decision`.
 */
export const RECALLABLE_KINDS = [
  "fact",
  "decision",
  "strategy",
  "workflow",
  "skill",
  "episode",
  "task",
  "event",
  "reasoning",
] as const;

export type RecallableKind = (typeof RECALLABLE_KINDS)[number];

/**
 * Kinds `recallCold` searches when a caller supplies no `RecallQuery.kinds`
 * filter (spec.md Requirement 4 / design.md D4 — conservatism lives in the
 * damping/gating parameters, not in an opt-out here). Defined as its own
 * export, distinct from RECALLABLE_KINDS, because the two lists are allowed
 * to diverge later: a kind can become recallable (indexed on write) before
 * it ships default-on in recall results.
 */
export const DEFAULT_RECALL_KINDS: readonly RecallableKind[] = [
  "fact",
  "decision",
  "strategy",
  "workflow",
  "skill",
  "episode",
];

/**
 * The three kinds that are INDEXED but not returned by default. Kept as its own
 * export so the split is stated once and readable, rather than inferred by
 * diffing two lists.
 *
 * `task` and `event` are operational records, not knowledge: a cancelled ticket
 * or a webhook delivery surfacing on an unrelated question is noise, and noise
 * in a recall budget costs a real answer its slot. `reasoning` is a stored
 * chain-of-thought — valuable when you ask for it ("how did we conclude X?"),
 * and misleading when it arrives unbidden, because a discarded line of
 * reasoning reads exactly like a conclusion.
 *
 * All three ARE reachable: `RecallQuery.kinds` overrides this entirely, so an
 * agent that wants them asks for them.
 */
export const NON_DEFAULT_RECALLABLE_KINDS: readonly RecallableKind[] = [
  "task",
  "event",
  "reasoning",
];

/**
 * P65 wave 1 — why `strategy` and `workflow` went first, and why they are
 * default-on rather than merely indexed.
 *
 * They are reusable heuristics and processes: "when X, do Y" and "here is how
 * we do Z". That is precisely the content an agent benefits from finding
 * WITHOUT having been told to look, which is what default-on means. A `task` or
 * an `event` surfacing on every unrelated recall is noise — those are next, and
 * the plan is to index them without defaulting them, which is the distinction
 * `RECALLABLE_KINDS` vs `DEFAULT_RECALL_KINDS` exists to express and which was
 * unused until now (the two lists were identical).
 *
 * What the backlog under-estimated: adding a kind is NOT only a registry entry.
 * Of the seven write-only kinds, only `episode`, `skill`, `strategy` and
 * `reasoning` had an `embedding` column at all, and NONE had `text_lemmatized`.
 * `workflow`, `task` and `event` had neither. Migration 0033 gave these two what
 * recall needs; the remaining five each still need theirs.
 */

/** Narrows `kind` to `RecallableKind` when it is one of RECALLABLE_KINDS. */
export function isRecallableKind(kind: PrimitiveKind): kind is RecallableKind {
  return (RECALLABLE_KINDS as readonly string[]).includes(kind);
}

/**
 * Declares exactly which fields of a primitive's row are embedded/indexed
 * for a given recallable kind, and how they are joined into one text blob.
 * `separator` is inserted only between fields that are actually present
 * (non-empty strings) — a missing/empty field is skipped, never emitted as
 * the literal string `"undefined"`.
 */
export interface TextProjection {
  readonly fields: readonly string[];
  readonly separator: string;
}

/**
 * Per-kind text projection — the single source of truth for "what exactly
 * gets embedded" for each recallable kind. Replaces the three previously
 * hardcoded `title + " " + body` sites for decisions
 * (`DecisionRepository.ts:57`, `:121`, `EmbeddingRepository.ts:16`); all
 * three now derive from this constant instead of duplicating the join.
 */
export const PRIMITIVE_TEXT_PROJECTION: Record<RecallableKind, TextProjection> = {
  fact: { fields: ["statement"], separator: " " },
  decision: { fields: ["title", "body"], separator: " " },
  // The trigger→action pair IS the heuristic; either half alone is
  // unsearchable. "when the build goes red" means nothing without what to do
  // about it, and "re-run with --no-cache" means nothing without when.
  strategy: { fields: ["trigger", "action"], separator: " " },
  // `description` is optional on MnemoWorkflow, and projectPrimitiveText skips
  // empty fields rather than emitting the literal "undefined", so a
  // name-only workflow still projects cleanly.
  workflow: { fields: ["name", "description"], separator: " " },
  // The template IS the skill; the name alone is a label.
  skill: { fields: ["name", "promptTemplate"], separator: " " },
  // Matches the createEpisode producer's text-form outbox payload, so a §36
  // model migration re-embeds the same text the lexical column indexes.
  episode: { fields: ["title", "narrative"], separator: " " },
  task: { fields: ["title", "description"], separator: " " },
  event: { fields: ["name", "description"], separator: " " },
  reasoning: { fields: ["question", "conclusion"], separator: " " },
};

// ─── Embedding widths ─────────────────────────────────────────────────────────

/**
 * The vector widths this schema physically supports — the single source of
 * truth, replacing "whatever positive integer someone typed".
 *
 * These four are not a preference, they are what the database has tables for:
 * `mnemo_fact_embeddings_1024 / _1536 / _2048 / _4096`
 * (`adapter-postgres/src/schema/vector_space.ts`), plus the dimension-scoped
 * HNSW indexes migration 0010 builds over them.
 *
 * P117 is why this constant exists. `MNEMO_EMBED_DIMENSIONS` accepted any
 * positive integer, and `mnemo_fact.embedding` is an unconstrained `halfvec`,
 * so a workspace configured at 768 wrote facts perfectly well — and could never
 * delete them, because `archiveFact()` copies the row into a table that WAS
 * pinned at 1536. Data you can create and cannot forget. The archive column is
 * unconstrained now (migration 0032), but the wider point stands: a width with
 * no index behind it is a silent performance cliff, and the place to refuse it
 * is the moment it is configured or written — not three operations later, in an
 * error message at the end of an 8 KB SQL dump.
 *
 * Adding a width means adding its table and index first. This list follows the
 * schema; it never leads it.
 */
export const SUPPORTED_EMBED_DIMENSIONS = [1024, 1536, 2048, 4096] as const;

export type SupportedEmbedDimension = (typeof SUPPORTED_EMBED_DIMENSIONS)[number];

/** Narrows `n` to a width the schema has a table and an index for. */
export function isSupportedEmbedDimension(n: number): n is SupportedEmbedDimension {
  return (SUPPORTED_EMBED_DIMENSIONS as readonly number[]).includes(n);
}

/**
 * Throws unless `n` is a supported width. `context` names the caller so the
 * message says which knob to turn — the failure this replaces surfaced as
 * `expected 1536 dimensions, not 768` from deep inside a Drizzle insert, which
 * named neither the setting nor the fact.
 */
export function assertSupportedEmbedDimension(n: number, context: string): void {
  if (!isSupportedEmbedDimension(n)) {
    throw new Error(
      `${context}: unsupported embedding width ${n}. ` +
        `This schema has vector tables and indexes only for ` +
        `${SUPPORTED_EMBED_DIMENSIONS.join(", ")}. ` +
        `Pick an embedding model with one of those widths (or add the table, ` +
        `index and migration for ${n} first).`
    );
  }
}

/**
 * Joins a recallable kind's declared fields out of `row` into the one text blob
 * that gets embedded and lexically indexed. Pure.
 *
 * A missing or non-string field is skipped rather than emitted as the literal
 * `"undefined"` — which matters for optional projected fields like
 * `workflow.description`: a name-only workflow must index as its name, not as
 * `"deploy undefined"`.
 *
 * P65 moved this here from `@mnemo-ai/core`. It is a pure function over
 * PRIMITIVE_TEXT_PROJECTION, and the in-memory adapter in `types/testing` needs
 * it to satisfy the same write contract the real adapters do — types cannot
 * import from core, so a helper living in core made the double structurally
 * unable to mirror the thing it doubles. Core re-exports it, so every existing
 * import keeps working.
 */
export function projectPrimitiveText(kind: RecallableKind, row: Record<string, unknown>): string {
  const projection = PRIMITIVE_TEXT_PROJECTION[kind];
  return projection.fields
    .map((field) => row[field])
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(projection.separator);
}
