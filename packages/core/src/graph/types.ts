// packages/mnemosyne/src/graph/types.ts
// Framework-agnostic types for the Memory Graph.
// No React, no Next.js, no Drizzle — safe to import in any environment.

export type GraphEntityKind = "person" | "organization" | "project" | "concept" | "place" | "other";

export type GraphNodeKind = "entity" | "episode" | "decision";

export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  entityKind?: GraphEntityKind;
  label: string;
  description?: string | null;
  mentionCount: number;
  factCount: number;
  avgMemoryStrength: number;
  createdAt: string; // ISO 8601
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  relation: string;
  confidence: number;
  provenance: string | null;
}

export interface GraphResponse {
  nodes: GraphNode[];
  edges: GraphEdge[];
  meta: {
    entityCount: number;
    episodeCount: number;
    decisionCount: number;
    relationCount: number;
  };
}

export interface GraphQueryOptions {
  focusEntityId?: string;
  /** When true, overlay precomputed semantic-neighbor edges onto the graph. */
  includeSemantic?: boolean;
  /**
   * Reconstruct the graph as it stood at this instant (bitemporal).
   * Nodes created after this date are excluded; relations are filtered by
   * their valid_from/valid_to window (valid_from <= asOf AND (valid_to IS NULL
   * OR valid_to > asOf)). When omitted, the current live graph is returned.
   */
  asOf?: Date;
}
