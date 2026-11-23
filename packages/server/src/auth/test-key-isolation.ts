/**
 * AB6.2 — mk_test_ sandbox key isolation (spec §35 lines 4293–4299).
 *
 * Convention (mirrors Stripe sk_test_ / sk_live_):
 *   - mk_test_  keys are bound to workspaces where is_test = true
 *   - All other key prefixes (mk_live_, mk_admin_, mk_sess_, mk_fed_) are
 *     bound to production workspaces where is_test = false
 *
 * The `ScopedApiKeyAdapter.authenticate()` MUST call validateTestKeyBinding()
 * after looking up the record and the workspace's is_test flag. If the binding
 * check fails, return { ok: false, code: 'FORBIDDEN', reason: 'test/prod key mismatch' }.
 *
 * No DB imports here — pure logic.
 */

/** Returns true if the raw API key starts with the mk_test_ prefix. */
export function isTestKey(rawKeyOrPrefix: string): boolean {
  return rawKeyOrPrefix.startsWith("mk_test_");
}

/**
 * Validate that a key's prefix is compatible with the workspace's is_test flag.
 *
 * @param keyPrefix   The ApiKeyType prefix (e.g. "mk_test_", "mk_live_")
 * @param isTestWorkspace  The workspace's is_test column value
 * @returns true if the binding is valid, false if it should be rejected with 403
 */
export function validateTestKeyBinding(
  keyPrefix: string,
  isTestWorkspace: boolean,
): boolean {
  const keyIsTest = keyPrefix === "mk_test_";
  // Test key must only access test workspaces.
  // Non-test keys must not access test workspaces.
  return keyIsTest === isTestWorkspace;
}
