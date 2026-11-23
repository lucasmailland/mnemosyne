// Fail-closed pepper gate (H3).
//
// MNEMO_KEY_PEPPER is the HMAC key used to blind API tokens before DB storage
// (auth.ts). An empty or short pepper means all API tokens share a trivial
// blinding factor — a compromised DB exposes valid raw tokens. In production
// (or when MNEMO_REQUIRE_PEPPER=true) a missing/short pepper is fatal; in dev
// we warn and degrade (empty string is historical behaviour).
//
// Pure function — takes an env bag so it is unit-testable without mutating
// process.env. The boot path passes process.env.

export type PepperPosture = "strong" | "weak";

const MIN_PEPPER_BYTES = 32;

/**
 * Decide the pepper posture, throwing (fail-closed) when a strong pepper is
 * mandatory but unavailable or too short.
 *
 * Mandatory when NODE_ENV === "production" OR MNEMO_REQUIRE_PEPPER === "true".
 *
 * @returns "strong" when MNEMO_KEY_PEPPER is present and >= 32 chars.
 * @returns "weak"   when pepper is NOT mandatory and the key is absent or short
 *          (dev convenience — caller should warn).
 * @throws  when pepper is mandatory and the key is missing or < 32 chars.
 */
export function assertPepperAvailable(
  env: Record<string, string | undefined>,
): PepperPosture {
  const required =
    env.NODE_ENV === "production" || env.MNEMO_REQUIRE_PEPPER === "true";
  const pepper = env.MNEMO_KEY_PEPPER ?? "";

  if (pepper.length < MIN_PEPPER_BYTES) {
    if (required) {
      throw new Error(
        `MNEMO_KEY_PEPPER must be at least ${MIN_PEPPER_BYTES} characters when ` +
          "NODE_ENV=production or MNEMO_REQUIRE_PEPPER=true. A missing or short " +
          "pepper means API tokens are stored with a trivial blinding factor — a " +
          "compromised DB would expose raw tokens. Refusing to start. " +
          'Generate one with: node -e "console.log(require(\'node:crypto\').randomBytes(32).toString(\'hex\'))"',
      );
    }
    return "weak";
  }

  return "strong";
}
