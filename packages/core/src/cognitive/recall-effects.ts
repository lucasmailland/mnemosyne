import type { RecallQuery } from "@mnemo-ai/types";

/**
 * Whether a recall may train the organic corpus: the recall log (TD worth),
 * hot-tier activation and co-recall graph learning. Synthetic traffic
 * (evaluation, installer verification) still retrieves, but leaves no trace.
 * A query without an effects context is organic, as before the flag existed.
 */
export function appliesOrganicEffects(query: Pick<RecallQuery, "effects">): boolean {
  return query.effects?.applyOrganicEffects !== false;
}
