/**
 * rotateWorkspaceKek — re-wrap every live DEK under a new KEK version.
 *
 * Design rationale
 * ────────────────
 * • DEK plaintext is unchanged: only the *wrapped* form changes, so no
 *   re-encryption of existing ciphertext is needed.
 * • Destroyed DEKs (null encryptedKey) are skipped — nothing to re-wrap.
 * • The caller (DrizzleStorageAdapter) owns the transaction and GUC setup.
 *   This function is pure logic: iterate DEKs, unwrap with oldRing, re-wrap
 *   with newRing, call updateFn for each re-wrapped DEK.
 * • The DrizzleStorageAdapter also inserts/upserts the workspaceKekTable row
 *   recording the new kek_version after this returns.
 *
 * Interface note: `KeyRingLike` is a structural interface (duck-typing) so
 * this module does NOT import from `@mnemo-ai/server` — hexagonal purity.
 * The concrete `KeyRingAdapter` in packages/server satisfies `KeyRingLike`
 * without any explicit `implements`.
 */

export interface KeyRingLike {
  wrapDek(workspaceId: string, actorId: string, dek: Buffer): string;
  unwrapDek(workspaceId: string, actorId: string, wrapped: string): Buffer;
}

export interface LiveDekRow {
  id: string;
  workspaceId: string;
  actorId: string;
  encryptedKey: string | null;
}

/**
 * Re-wrap every live DEK in `deks` from `oldRing` → `newRing`.
 *
 * @param workspaceId  - workspace scope (passed to ring for HKDF AAD)
 * @param oldRing      - ring that can unwrap the current wrapped DEKs
 * @param newRing      - ring to re-wrap under (new KEK version)
 * @param deks         - all active DEK rows for the workspace
 * @param onUpdate     - called for each re-wrapped DEK (default: no-op)
 * @returns            - number of DEKs successfully re-wrapped
 */
export async function rotateWorkspaceKek(
  workspaceId: string,
  oldRing: KeyRingLike,
  newRing: KeyRingLike,
  deks: LiveDekRow[],
  onUpdate?: (dekId: string, newWrapped: string) => void | Promise<void>,
): Promise<number> {
  let count = 0;

  for (const row of deks) {
    // Skip destroyed DEKs — their encryptedKey is null; no re-wrap possible.
    if (!row.encryptedKey) continue;

    // Unwrap the plaintext DEK using the OLD ring.
    const plaintextDek = oldRing.unwrapDek(workspaceId, row.actorId, row.encryptedKey);

    // Re-wrap under the NEW ring.
    const newWrapped = newRing.wrapDek(workspaceId, row.actorId, plaintextDek);

    // Notify the caller (usually: UPDATE mnemo_actor_dek SET encrypted_key = $newWrapped WHERE id = $row.id).
    if (onUpdate) {
      await onUpdate(row.id, newWrapped);
    }

    count++;
  }

  return count;
}
