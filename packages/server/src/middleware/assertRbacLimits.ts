// Fail-closed assertion that §19 per-agent RBAC limits cannot silently no-op (F11).
//
// rbac-policy.ts gates per-agent rate limits, per-session self-edit limits, and
// concurrent-session limits ONLY when deps.rateCounter / deps.activeSessions are
// present; when absent it fails open. In production that means a misconfigured
// cache (no incrWithTtl) silently disables every per-agent limit. This boot-time
// assertion makes that configuration fatal so limits cannot quietly vanish.
//
// Pure function — takes the wired deps + an env bag so it is unit-testable.

export interface RbacLimitDeps {
  rateCounter?: { incrWithTtl(key: string, ttlSeconds: number): Promise<number> } | undefined;
  activeSessions?: { countActive(workspaceId: string, actorId: string): Promise<number> } | undefined;
}

/**
 * Throw when RBAC limit deps are required (production, or
 * MNEMO_REQUIRE_RBAC_LIMITS=true) but not wired. No-op (caller warns) otherwise.
 */
export function assertRbacLimitsWired(
  deps: RbacLimitDeps,
  env: Record<string, string | undefined>,
): void {
  const required =
    env.NODE_ENV === "production" || env.MNEMO_REQUIRE_RBAC_LIMITS === "true";
  if (!required) return;

  const missing: string[] = [];
  if (!deps.rateCounter) missing.push("rateCounter (cache.incrWithTtl)");
  if (!deps.activeSessions) missing.push("activeSessions (concurrent-session probe)");

  if (missing.length > 0) {
    throw new Error(
      "§19 RBAC per-agent limits would fail open: missing " +
        missing.join(", ") +
        ". Refusing to start in production with rate/session limits silently " +
        "disabled. Wire a Redis cache adapter (incrWithTtl) and an active-session " +
        "probe, or set MNEMO_REQUIRE_RBAC_LIMITS=false to opt out explicitly.",
    );
  }
}
