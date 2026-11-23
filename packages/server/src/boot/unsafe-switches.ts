// Dev-only switches that weaken security. With NODE_ENV=production the server
// refuses to start if any is on, instead of only warning (R-24).
//
// Pure function over an env bag so it is unit-testable; the boot path passes
// process.env.

const UNSAFE_IN_PRODUCTION = [
  // Dashboard session cookie without the Secure flag.
  "MNEMO_DASHBOARD_INSECURE_COOKIE",
  // Skips the superuser / BYPASSRLS check, so RLS isolation can be void.
  "MNEMO_ALLOW_UNSAFE_DB_ROLE",
  // Accepts federation peers over plain HTTP: the pull key and JWT travel in clear.
  "MNEMO_FED_INSECURE_TRANSPORT",
] as const;

/** Names of the unsafe switches set to "true" while NODE_ENV=production. */
export function unsafeSwitchesInProduction(env: Record<string, string | undefined>): string[] {
  if (env.NODE_ENV !== "production") return [];
  return UNSAFE_IN_PRODUCTION.filter((name) => env[name] === "true");
}
