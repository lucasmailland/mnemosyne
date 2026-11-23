// P135 — list routes filter by project the way recall does: a `scopeRef` that
// names a project entity (by name or alias) matches every spelling of it.

import { resolveProjectScopeRef } from "@mnemo-ai/core";
import type { StorageAdapter } from "@mnemo-ai/types";

/**
 * The `scopeRef` / `scopeRefAliases` pair to spread into a storage filter.
 * Empty when the request names no scopeRef.
 */
export async function projectScopeFilter(
  storage: Pick<StorageAdapter, "queryEntities">,
  workspaceId: string,
  scopeRef: string | undefined
): Promise<{ scopeRef?: string; scopeRefAliases?: string[] }> {
  if (!scopeRef) return {};
  const r = await resolveProjectScopeRef(storage, workspaceId, scopeRef);
  return {
    scopeRef: r.scopeRef,
    ...(r.aliases.length > 0 ? { scopeRefAliases: r.aliases } : {}),
  };
}
