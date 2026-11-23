/**
 * B8 (docs/archive/openspec/complete-mcp-tools, spec.md Requirement 7) — the only real
 * caller of `StorageAdapter.updateWorth(..., "hyperedge", ...)`. Before this,
 * the TD(λ) hyperedge-worth mechanism existed (RecallRepository.ts:172-187,
 * mirrored in InMemoryStorageAdapter) but nothing ever invoked it, so
 * `worth` stayed frozen at its 0.5 creation default forever.
 *
 * Fired via `setImmediate`, never awaited in the hot path, all errors
 * swallowed — the same pattern the server-side co-recall STDP pass that used
 * to share this call site also followed (that pass was deleted by
 * p60-corecall-stdp-convergence; core's `recordCoRecall` is now the sole
 * co-recall STDP writer). Loads the hyperedges touched by the served hit set
 * via `getRecallStructures`, then for each
 * hyperedge counts how many of its members were actually served in this
 * response: >=2 members present is treated as a co-activation success
 * (worth credited), exactly 1 present is treated as a partial/failure signal
 * (worth debited). A hyperedge with 0 members in the served set never
 * appears in `getRecallStructures`'s result and is left untouched.
 */
import type { StorageAdapter } from "@mnemo-ai/types";

export async function recordHyperedgeCoActivation(
  storage: StorageAdapter,
  workspaceId: string,
  hitIds: string[]
): Promise<void> {
  const structures = await storage.getRecallStructures(workspaceId, hitIds, 10);
  const presentByHyperedge = new Map<string, Set<string>>();
  for (const { memberId, hyperedge } of structures.hyperedges) {
    const present = presentByHyperedge.get(hyperedge.id) ?? new Set<string>();
    present.add(memberId);
    presentByHyperedge.set(hyperedge.id, present);
  }
  for (const [hyperedgeId, present] of presentByHyperedge) {
    if (present.size >= 2) {
      await storage.updateWorth(hyperedgeId, workspaceId, "hyperedge", {
        success: 1,
        failure: 0,
        creditWeight: 1,
      });
    } else if (present.size === 1) {
      await storage.updateWorth(hyperedgeId, workspaceId, "hyperedge", {
        success: 0,
        failure: 1,
        creditWeight: 1,
      });
    }
  }
}
