import type postgres from "postgres";

export interface PgPoolStats {
  active: number;
  idle: number;
  total: number;
}

/**
 * Reads live connection counts from a postgres-js sql instance.
 * postgres-js v3 stores state on private fields — all accesses are
 * guarded so a version change degrades to zeros rather than throwing.
 */
export function readPgPoolStats(sql: ReturnType<typeof postgres>): PgPoolStats {
  try {
    const s = sql as unknown as {
      reserved?: unknown[];
      options?: { max?: number };
    };
    const total = typeof s.options?.max === "number" ? s.options.max : 0;
    const active = Array.isArray(s.reserved) ? s.reserved.length : 0;
    const idle = Math.max(total - active, 0);
    return { active, idle, total };
  } catch {
    return { active: 0, idle: 0, total: 0 };
  }
}

export function computePoolUtilFromStat(s: { active: number; max: number }): number {
  if (s.max <= 0) return 0;
  return Math.max(0, Math.min(1, s.active / s.max));
}

/** Reads cluster-wide connection pressure from pg_stat_activity vs max_connections. */
export async function readPgStatActivityUtil(sql: ReturnType<typeof postgres>): Promise<number> {
  try {
    const rows = await sql<Array<{ active: number; max: number }>>`
      SELECT
        (SELECT count(*)::int FROM pg_stat_activity WHERE state IS NOT NULL AND state <> 'idle') AS active,
        (SELECT setting::int FROM pg_settings WHERE name = 'max_connections') AS max
    `;
    const r = rows[0];
    return r ? computePoolUtilFromStat(r) : 0;
  } catch {
    // Degrade to "no pressure" on the hot path — this is intentional: a
    // metrics read failure must never block the request path.
    return 0;
  }
}
