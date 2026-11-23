// Fail-closed encryption gate (F8).
//
// At boot the server must REFUSE to start when it is configured to run in a
// production / encryption-required posture but the master key needed for
// column-level encryption (SECURITY.md §7 / MEMORY_IMPROVEMENT.md
// "Encryption Layers") is missing or malformed. In dev convenience mode we keep
// the historical warn-and-degrade behavior.
//
// Pure function — takes an env bag so it is unit-testable without mutating
// process.env. The boot path passes process.env.

export type EncryptionPosture = "enabled" | "disabled";

/**
 * Decide the encryption posture, throwing (fail-closed) when encryption is
 * mandatory but unavailable.
 *
 * Mandatory when NODE_ENV === "production" OR MNEMO_REQUIRE_ENCRYPTION === "true".
 *
 * @returns "enabled"  when a valid 64-hex MNEMO_MASTER_KEY is present.
 * @returns "disabled" when encryption is NOT mandatory and the key is absent
 *          (dev convenience — caller should warn).
 * @throws  when encryption is mandatory and the key is missing or malformed.
 */
export function assertEncryptionAvailable(
  env: Record<string, string | undefined>
): EncryptionPosture {
  const required = env.NODE_ENV === "production" || env.MNEMO_REQUIRE_ENCRYPTION === "true";
  const masterKey = env.MNEMO_MASTER_KEY;

  if (!masterKey) {
    if (required) {
      throw new Error(
        "MNEMO_MASTER_KEY is required when NODE_ENV=production or " +
          "MNEMO_REQUIRE_ENCRYPTION=true. Refusing to start with encryption " +
          "silently disabled (confidential/restricted facts would be stored as " +
          "plaintext). Generate one with: " +
          "node -e \"console.log(require('node:crypto').randomBytes(32).toString('hex'))\""
      );
    }
    return "disabled";
  }

  // Key present — validate shape so a malformed key fails loudly at boot in a
  // required posture rather than at first encryption call.
  if (masterKey.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(masterKey)) {
    if (required) {
      throw new Error("MNEMO_MASTER_KEY must be 64 hex chars (32 bytes). Refusing to start.");
    }
    return "disabled";
  }

  return "enabled";
}
