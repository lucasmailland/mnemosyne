// Shared value types used across multiple primitives and ports.

export type Sensitivity = "public" | "internal" | "confidential" | "restricted";

export type Attribution = "user_stated" | "user_belief" | "objective_fact" | "inferred";

/**
 * Five decay classes mapping PrimitiveKind to a half-life (spec §25.2).
 * "entity" has half-life 0 (immortal — no decay ever applied).
 */
export type DecayClass = "procedural" | "semantic" | "episodic" | "entity" | "reasoning";

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

export interface WorthDelta {
  success: number; // fractional TD(λ) credit to add to worth_success
  failure: number; // fractional TD(λ) credit to add to worth_failure
  creditWeight: number; // eligibility trace weight — NUMERIC(8,6) in DB
}

export interface VectorEmbedding {
  id: string;
  workspaceId: string;
  primitiveKind: string;
  vector: Float32Array; // halfvec(1536) in DB
  model: string;
}

export interface VectorQuery {
  workspaceId: string;
  vector: Float32Array;
  limit: number;
  minSimilarity?: number;
  filter?: Record<string, unknown>;
}

export interface VectorSearchResult {
  id: string;
  score: number;
  primitiveKind: string;
}

export interface HealthStatus {
  status: "ok" | "degraded" | "down";
  latencyMs: number;
  detail?: string;
}
