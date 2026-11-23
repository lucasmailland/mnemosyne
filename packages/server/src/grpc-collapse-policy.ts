/**
 * F2: resolve the CollapsePolicy for a gRPC session collapse. Loads the session
 * to find its agentId, then the agent profile, and overlays its CollapsePolicy on
 * documented defaults. Degrades to defaults when storage / session / agentId is
 * absent. Never throws — resolution failure yields defaults.
 */
import type { StorageAdapter } from "@mnemo-ai/types";
import { resolveCollapsePolicy, type CollapsePolicy } from "@mnemo-ai/core";

export async function resolveCollapsePolicyForSession(
  storage: StorageAdapter | undefined,
  sessionId: string,
  workspaceId: string,
): Promise<CollapsePolicy> {
  if (!storage) return resolveCollapsePolicy(null);
  try {
    const session = await storage.getSession(sessionId, workspaceId);
    const agentId = session?.agentId;
    if (!agentId) return resolveCollapsePolicy(null);
    const profile = await storage.getAgentProfile(workspaceId, agentId);
    return resolveCollapsePolicy(profile);
  } catch {
    // Resolution failure is non-fatal — fall back to documented defaults.
    // (No silent swallow of real logic: this only guards profile lookup.)
    return resolveCollapsePolicy(null);
  }
}
