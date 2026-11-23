// packages/core/src/primitives/fact-types.ts
//
// flatten-legacy-dual-core Phase 9 (task 9.3): types-only extract from the
// now-deleted `primitives/fact.ts`. That file's CRUD functions
// (`createFact`/`getFact`/`forgetFact`/`listFacts`/`markRecalled`) were
// confirmed dead (zero callers anywhere in the repo, re-verified in this
// PR — see apply-progress.md) and deleted outright, but the legacy v1.x
// `MnemoFact` type shape (and its satellite `FactKind`/`FactScope`/
// `FactStatus`/`MemoryType`/`EmbeddingTier` types) is still imported
// (type-only) by `packages/core/src/benchmark/fixtures.ts` — required by
// the CI-invoked `pnpm bench`/`bench:check`/`bench:quality` scripts
// (.github/workflows/ci.yml) — and by `packages/core/src/recall/render.ts`.
//
// This file is deliberately types-only: zero infra imports (no
// drizzle-orm/postgres/pg), so it needs no `LEGACY_INFRA_ALLOWLIST` entry
// in v3-purity.test.ts — unlike the deleted `fact.ts`, which required one
// purely because of its now-removed CRUD functions' `drizzle-orm` imports.
import type { Attribution } from "../types";

export type FactKind =
  | "preference"
  | "trait"
  | "event"
  | "relationship"
  | "skill"
  | "concern"
  | "architecture"
  | "bugfix"
  | "config"
  | "discovery"
  | "policy"
  | "process"
  | "other";
export type FactScope = "global" | "conversation";
export type FactStatus = "active" | "merged" | "forgotten";
/**
 * Mnemosyne v1.4 — "The Cognitive Leap". Separates facts by the way
 * human cognition does. Default 'semantic' matches the SQL DEFAULT so
 * legacy callers (and every pre-v1.4 row) keep their current behaviour.
 */
export type MemoryType = "semantic" | "episodic" | "procedural" | "working";

/**
 * v1.6 — embedding tier. Set by the resolver to mark a fact as
 * "premium" (uses the workspace's premium embedding model) or
 * "default" (cheap-tier).
 */
export type EmbeddingTier = "default" | "premium";

export interface MnemoFact {
  id: string;
  workspaceId: string;
  agentId: string | null;
  scope: FactScope;
  scopeRef: string | null;
  kind: FactKind;
  subject: string;
  statement: string;
  confidence: number;
  pinned: boolean;
  relevance: number;
  hitCount: number;
  lastRecalledAt: Date | null;
  sourceMessageIds: string[];
  attributedTo: "user" | "assistant" | "system" | null;
  linkedMemoryIds: string[];
  embedding: number[] | null;
  metadata: Record<string, unknown>;
  status: FactStatus;
  mergedIntoId: string | null;
  validFrom: Date;
  validTo: Date | null;
  createdAt: Date;
  updatedAt: Date;
  /**
   * v1.4 — cognitive classification (default 'semantic'). See MemoryType.
   * Optional so legacy row-mappers / hand-rolled test fixtures keep
   * compiling without a forced update.
   */
  memoryType?: MemoryType;
  /**
   * v1.4 — per-conversation actor isolation (migration 0037). When set,
   * tracks the User.id this fact was learned from. NULL = workspace-
   * shared. Semantic reference, no FK.
   */
  actorId?: string | null;
  /**
   * v1.4 — theory-of-mind attribution (migration 0035).
   */
  attribution?: Attribution;
  /**
   * v1.6 (G2) — link to `mnemo_entity` row (migration 0039).
   */
  entityId?: string | null;
  /**
   * v1.6 (G2) — Memory Protocol version under which this fact was
   * extracted (migration 0041). Defaults to 'v1.1' at the SQL layer.
   */
  protocolVersion?: string;
  /**
   * v1.1 #10 — Hebbian trace strength in [0.05, 5.0]. Default 1.0.
   */
  memoryStrength?: number;
  /**
   * v1.1 #10 — forgetting-curve time constant in days. Higher = slower
   * decay. Default 1.0.
   */
  memoryStability?: number;
  /**
   * v1.1 #10 — timestamp of the last decay + potentiation pass.
   */
  lastStrengthUpdate?: Date | null;
  /**
   * v1.1 #13 — virtual line number within the entity's active-fact drawer.
   */
  drawerLine?: number | null;
  /**
   * Per-fact sensitivity ceiling (migration: mnemo_fact.sensitivity).
   * Compared via SENSITIVITY_ORDER, never string equality (MED-23).
   */
  sensitivity?: "public" | "internal" | "confidential" | "restricted";
}
