/**
 * Canonical EmbeddingSpace identity (§B4.1).
 *
 * Vectors can only be compared when they share the exact same EmbeddingSpace.
 */
export interface EmbeddingSpace {
  spaceId: string;
  provider: string;
  model: string;
  modelRevision?: string;
  dimensions: number;
  distanceMetric: "cosine" | "ip" | "l2";
  inputType?: "document" | "query" | "symmetric";
  normalization?: "l2" | "none";
  dtype?: "float32" | "float16" | "int8";
  preprocessingVersion?: string;
}

export type EmbeddingSpaceStatus =
  | "building"
  | "active"
  | "dormant"
  | "stale"
  | "superseded"
  | "failed";

/**
 * Generate a deterministic canonical spaceId string.
 */
export function generateSpaceId(space: Omit<EmbeddingSpace, "spaceId">): string {
  const parts = [
    space.provider,
    space.model,
    space.modelRevision ?? "v1",
    String(space.dimensions),
    space.distanceMetric ?? "cosine",
    space.dtype ?? "float32",
  ];
  return parts.join(":").toLowerCase();
}
