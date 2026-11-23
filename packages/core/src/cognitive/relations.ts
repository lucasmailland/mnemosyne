// TASK-3007: Hebbian relation strength update (η=0.1, β=0.05 decay).
// COGNITIVE_ALGORITHMS.md §7.
//
// Hebb rule: Δw = η × reinforced - β × w
//   If reinforced=true:  weight += η × (1 - weight)   (approach 1.0, bounded)
//   If reinforced=false: weight -= β × weight          (approach 0.0, exponential decay)
//
// The storage adapter applies weight = CLAMP(new_weight, 0.0, 1.0).

import type { AuthContext } from "@mnemo-ai/types";
import type { CoreContext } from "./context.js";

const HEBB_ETA = 0.1; // learning rate
const HEBB_BETA = 0.05; // decay rate

export async function updateRelationStrength(
  ctx: CoreContext,
  relationId: string,
  reinforced: boolean,
  auth: AuthContext
): Promise<void> {
  const span = ctx.telemetry.startSpan("mnemo.relation.hebb", {
    attributes: { relationId, reinforced, workspaceId: auth.workspaceId },
  });

  try {
    // Fetch the CURRENT weight of THIS relation to compute the Hebbian delta.
    // (Previously this took getRelations({sourceId: undefined})[0] — an arbitrary
    // relation's weight, ignoring relationId entirely.) getRelations takes a
    // filter, not an id, so select the matching row by id.
    const relations = await ctx.storage
      .getRelations({ workspaceId: auth.workspaceId, openOnly: false })
      .catch(() => []);
    const relation = relations.find((r) => r.id === relationId);

    // If we can't fetch, apply a safe default delta
    const currentWeight = relation?.weight ?? 0.5;

    const delta = reinforced
      ? HEBB_ETA * (1.0 - currentWeight) // Hebbian potentiation
      : -HEBB_BETA * currentWeight; // Hebbian depression

    await ctx.storage.updateRelationStrength(relationId, delta);

    ctx.logger.debug("relation strength updated", {
      workspaceId: auth.workspaceId,
      relationId,
      reinforced,
      delta,
    });
  } finally {
    span.end();
  }
}
