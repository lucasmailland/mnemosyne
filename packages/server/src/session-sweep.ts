/**
 * Pure trigger decision for the inactivity sweep (F2). Replaces the hardcoded
 * 50 / 8192 / 30-minute SQL WHERE clause as the source of truth: thresholds now
 * come from the resolved per-(workspace,agent) CollapsePolicy.
 */
import type { CollapsePolicy } from "@mnemo-ai/core";

export type SweepReason = "max_turns" | "max_tokens" | "inactivity";

export function shouldCollapseUnderPolicy(
  state: { turnCount: number; tokenCount: number; ageSeconds?: number; inactivitySeconds?: number },
  policy: CollapsePolicy
): SweepReason | null {
  const maxTurns = policy.maxTurns ?? 50;
  const maxTokens = policy.maxTokens ?? 8192;
  const inactivityTimeout = policy.inactivityTimeout ?? 1800;
  if (state.turnCount >= maxTurns) return "max_turns";
  if (state.tokenCount >= maxTokens) return "max_tokens";
  if ((state.inactivitySeconds ?? state.ageSeconds ?? 0) >= inactivityTimeout) return "inactivity";
  return null;
}

export interface SweepCursor {
  activityAt: string;
  id: string;
}
export interface SweepCandidate {
  id: string;
  workspaceId: string;
  agentId?: string;
  turnCount: number;
  tokenCount: number;
  inactivitySeconds: number;
  collapseAttempts?: number;
  collapseRetryDue?: boolean;
}
const MAX_COLLAPSE_ATTEMPTS = 8;

/**
 * LIFECYCLE-14 — true when the attempt that just failed was the last one the
 * sweep will make (`attemptsBefore` is the count before it was recorded).
 */
export function isLastCollapseAttempt(attemptsBefore: number): boolean {
  return attemptsBefore + 1 >= MAX_COLLAPSE_ATTEMPTS;
}

function retryDue(row: SweepCandidate): boolean {
  return (row.collapseAttempts ?? 0) < MAX_COLLAPSE_ATTEMPTS && row.collapseRetryDue !== false;
}
export interface SweepPage {
  rows: SweepCandidate[];
  nextCursor: SweepCursor | null;
}
export interface SweepDiscoveryInput {
  workspaceId: string;
  limit: number;
  cursor?: SweepCursor | null;
}

/** Redis contributes hints only. Database pages always advance independently,
 * so stale cache members cannot suppress due rows or starve later pages. */
export async function discoverSweepCandidates(
  input: SweepDiscoveryInput,
  deps: {
    listDatabasePage(input: SweepDiscoveryInput): Promise<SweepPage>;
    listRedisIds(workspaceId: string, limit: number): Promise<string[]>;
    hydrateRedisIds(workspaceId: string, ids: string[]): Promise<SweepCandidate[]>;
    removeStaleRedisId(workspaceId: string, id: string): Promise<void>;
  }
): Promise<SweepPage> {
  const page = await deps.listDatabasePage(input);
  const union = new Map(page.rows.map((row) => [row.id, row]));
  try {
    const ids = [...new Set(await deps.listRedisIds(input.workspaceId, input.limit))].slice(
      0,
      input.limit
    );
    if (ids.length) {
      const rows = await deps.hydrateRedisIds(input.workspaceId, ids);
      const live = new Set(rows.map((row) => row.id));
      for (const row of rows) union.set(row.id, row);
      await Promise.allSettled(
        ids
          .filter((id) => !live.has(id))
          .map((id) => deps.removeStaleRedisId(input.workspaceId, id))
      );
    }
  } catch {
    /* PostgreSQL progress is authoritative when Redis is unavailable. */
  }
  return { rows: [...union.values()].filter(retryDue), nextCursor: page.nextCursor };
}

/** Production discovery. All workspace rows are read under FORCE-RLS scope;
 * time comes from PostgreSQL, never host wall-clock or Redis scores. */
export function createPostgresSweepDiscovery(deps: {
  storage: Pick<import("@mnemo-ai/types").StorageAdapter, "listWorkspaceIds">;
  sessionBuffer?: Pick<import("@mnemo-ai/core").SessionBuffer, "listActiveSessions">;
  cache?: Pick<import("@mnemo-ai/types").CacheAdapter, "zrem">;
  pageSize?: number;
}): () => Promise<SweepCandidate[]> {
  const cursors = new Map<string, SweepCursor>();
  let workspaceOffset = 0;
  return async () => {
    const { withMnemoTx } = await import("@mnemo-ai/core");
    const { sql } = await import("drizzle-orm");
    const limit = Math.min(500, Math.max(1, deps.pageSize ?? 100));
    const workspaceIds = (await deps.storage.listWorkspaceIds()).sort();
    const selected = workspaceIds.slice(workspaceOffset, workspaceOffset + 50);
    workspaceOffset = workspaceOffset + 50 >= workspaceIds.length ? 0 : workspaceOffset + 50;
    const result: SweepCandidate[] = [];
    type Row = {
      id: string;
      workspace_id: string;
      agent_id: string | null;
      turn_count: number;
      token_count: number;
      inactivity_seconds: number;
      activity_at: string;
      source_host: string | null;
      status: string;
      collapse_attempts: number | null;
      collapse_retry_due: boolean;
    };
    const map = (row: Row): SweepCandidate => ({
      id: row.id,
      workspaceId: row.workspace_id,
      agentId: row.agent_id ?? undefined,
      turnCount: row.turn_count,
      tokenCount: row.token_count,
      inactivitySeconds: Number(row.inactivity_seconds),
      collapseAttempts: row.collapse_attempts ?? 0,
      collapseRetryDue: row.collapse_retry_due,
    });
    for (const workspaceId of selected) {
      const liveManaged = new Set<string>();
      const page = await discoverSweepCandidates(
        { workspaceId, limit, cursor: cursors.get(workspaceId) },
        {
          listDatabasePage: async ({ cursor }) => {
            const rows = (await withMnemoTx(
              workspaceId,
              async (tx) =>
                await tx.execute(sql`
            SELECT id::text, workspace_id::text, agent_id::text, turn_count, token_count,
              EXTRACT(EPOCH FROM (clock_timestamp() - COALESCE(last_activity_at, started_at))) AS inactivity_seconds,
              COALESCE(last_activity_at, started_at)::text AS activity_at, source_host, status,
              collapse_attempts,
              (collapse_next_attempt_at IS NULL OR collapse_next_attempt_at <= clock_timestamp()) AS collapse_retry_due
            FROM mnemosyne.mnemo_session
            WHERE workspace_id = ${workspaceId} AND status = 'active' AND source_host IS NULL
              AND COALESCE(collapse_attempts, 0) < ${MAX_COLLAPSE_ATTEMPTS}
              AND (collapse_next_attempt_at IS NULL OR collapse_next_attempt_at <= clock_timestamp())
              ${cursor ? sql`AND (COALESCE(last_activity_at, started_at), id::text) > (${cursor.activityAt}::timestamptz, ${cursor.id})` : sql``}
            ORDER BY COALESCE(last_activity_at, started_at), id::text
            LIMIT ${limit}
          `)
            )) as unknown as Row[];
            const last = rows.at(-1);
            return {
              rows: rows.map(map),
              nextCursor:
                rows.length === limit && last
                  ? { activityAt: last.activity_at, id: last.id }
                  : null,
            };
          },
          // Fetch bounded hints without relying on client-clock eligibility. Hydration
          // below computes inactivity from the database clock for every returned row.
          listRedisIds: async (ws, maximum) =>
            deps.sessionBuffer?.listActiveSessions(ws, 0, Number.MAX_SAFE_INTEGER, maximum) ?? [],
          hydrateRedisIds: async (ws, ids) => {
            const rows = (await withMnemoTx(
              ws,
              async (tx) =>
                await tx.execute(sql`
            SELECT id::text, workspace_id::text, agent_id::text, turn_count, token_count,
              EXTRACT(EPOCH FROM (clock_timestamp() - COALESCE(last_activity_at, started_at))) AS inactivity_seconds,
              COALESCE(last_activity_at, started_at)::text AS activity_at, source_host, status,
              collapse_attempts,
              (collapse_next_attempt_at IS NULL OR collapse_next_attempt_at <= clock_timestamp()) AS collapse_retry_due
            FROM mnemosyne.mnemo_session WHERE workspace_id = ${ws}
              AND id::text = ANY(${ids}::text[]) AND status IN ('active', 'collapse_pending')
              AND COALESCE(collapse_attempts, 0) < ${MAX_COLLAPSE_ATTEMPTS}
              AND (collapse_next_attempt_at IS NULL OR collapse_next_attempt_at <= clock_timestamp())
          `)
            )) as unknown as Row[];
            for (const row of rows) if (row.source_host !== null) liveManaged.add(row.id);
            return rows.map(map);
          },
          removeStaleRedisId: async (ws, id) => {
            await deps.cache?.zrem?.(`mnemo:${ws}:sess:active`, id);
          },
        }
      );
      if (page.nextCursor) cursors.set(workspaceId, page.nextCursor);
      else cursors.delete(workspaceId);
      result.push(...page.rows.filter((row) => !liveManaged.has(row.id)));
    }
    return result;
  };
}
