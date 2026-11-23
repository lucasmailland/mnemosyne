/**
 * Postgres implementation of the IdempotencyStore port.
 *
 * begin() claims the key atomically with `INSERT ... ON CONFLICT DO NOTHING
 * RETURNING`: exactly one concurrent caller's INSERT succeeds (1 row returned →
 * "new"); every other caller sees the conflict (0 rows → reads the canonical
 * row → "in_flight" / "replay" / "mismatch"). This is what guarantees that two
 * simultaneous identical mutations cannot both execute.
 *
 * Spec §35 lines 3941–3970.
 */
import { sql } from "drizzle-orm";
import type { BeginResult, IdempotencyStore, RecoveryPoint } from "@mnemo-ai/types";
import { RECOVERY_POINTS } from "@mnemo-ai/types";
import type { DrizzleClient } from "./DrizzleStorageAdapter.js";

const RECOVERY_POINT_SET = new Set<string>(RECOVERY_POINTS);

export class DrizzleIdempotencyStore implements IdempotencyStore {
  constructor(private readonly db: DrizzleClient) {}

  async begin(
    workspaceId: string,
    key: string,
    requestHash: string,
  ): Promise<BeginResult> {
    return this.db.transaction(
      async (tx) => {
        // GUC — every DB transaction sets workspace context first.
        await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);

        // Atomically claim the key. `ON CONFLICT DO NOTHING ... RETURNING` lets
        // us distinguish the WINNER (1 row returned → our INSERT succeeded →
        // "new") from a concurrent duplicate or retry (0 rows → the key was
        // already claimed). The previous implementation omitted RETURNING and so
        // could never tell the two apart — it always returned "new", letting two
        // simultaneous identical mutations both execute (deep re-audit P0-6).
        const inserted = await tx.execute(sql`
          INSERT INTO mnemosyne.mnemo_idempotency_keys
            (workspace_id, key, request_hash, recovery_point, locked_at, created_at)
          VALUES (${workspaceId}, ${key}, ${requestHash}, 'started', now(), now())
          ON CONFLICT (workspace_id, key) DO NOTHING
          RETURNING key
        `);
        const insertedRows = (inserted as unknown as { rows?: unknown[] }).rows ?? inserted;
        if (Array.isArray(insertedRows) && insertedRows.length > 0) {
          // Our INSERT created the row — we are the first and only claimant.
          return { state: "new" } satisfies BeginResult;
        }

        // The key was already claimed (concurrent or prior request). Read the
        // canonical row to decide replay / mismatch / in_flight.
        const result = await tx.execute(sql`
          SELECT request_hash, recovery_point, response_code, response_body
          FROM mnemosyne.mnemo_idempotency_keys
          WHERE workspace_id = ${workspaceId} AND key = ${key}
          LIMIT 1
        `);
        const rawRows = (result as unknown as { rows?: unknown[] }).rows ?? result;
        const row = Array.isArray(rawRows)
          ? (rawRows[0] as Record<string, unknown> | undefined)
          : undefined;

        if (!row) {
          // Extremely unlikely: the conflicting row was deleted (TTL reaper)
          // between our INSERT and SELECT. Treat this attempt as a fresh claim.
          return { state: "new" } satisfies BeginResult;
        }

        // Mismatch: same key, different request body.
        if ((row["request_hash"] as string) !== requestHash) {
          return { state: "mismatch" } satisfies BeginResult;
        }

        // Completed: response was persisted → replay it verbatim.
        if (row["response_code"] != null) {
          return {
            state: "replay",
            responseCode: row["response_code"] as number,
            responseBody: row["response_body"] as string,
          } satisfies BeginResult;
        }

        // Matching hash, no response yet → a concurrent/earlier request still
        // holds the key. The middleware maps this to HTTP 409.
        return { state: "in_flight" } satisfies BeginResult;
      },
      // READ COMMITTED is the correct isolation for an idempotency claim:
      // `INSERT ... ON CONFLICT DO NOTHING RETURNING` is atomic, so exactly one
      // concurrent caller gets the row back ("new") and the rest see the
      // conflict and resolve to "in_flight". SERIALIZABLE would raise spurious
      // 40001 serialization failures on concurrent same-key inserts for no
      // benefit here.
      { isolationLevel: "read committed" },
    );
  }

  async complete(
    workspaceId: string,
    key: string,
    responseCode: number,
    responseBody: string,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      await tx.execute(sql`
        UPDATE mnemosyne.mnemo_idempotency_keys
        SET response_code    = ${responseCode},
            response_body    = ${responseBody},
            recovery_point   = 'completed'
        WHERE workspace_id = ${workspaceId} AND key = ${key}
      `);
    });
  }

  async recordPhase(
    workspaceId: string,
    key: string,
    phase: RecoveryPoint,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      // Idempotent: re-recording the same phase is a harmless UPDATE. We never
      // move a 'completed' row backwards, so guard with a strict phase check is
      // unnecessary — the route layer only advances forward.
      await tx.execute(sql`
        UPDATE mnemosyne.mnemo_idempotency_keys
        SET recovery_point = ${phase}
        WHERE workspace_id = ${workspaceId} AND key = ${key}
      `);
    });
  }

  async getRecoveryPoint(
    workspaceId: string,
    key: string,
  ): Promise<RecoveryPoint | null> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      const result = await tx.execute(sql`
        SELECT recovery_point
        FROM mnemosyne.mnemo_idempotency_keys
        WHERE workspace_id = ${workspaceId} AND key = ${key}
        LIMIT 1
      `);
      const rawRows = (result as unknown as { rows?: unknown[] }).rows ?? result;
      const row = Array.isArray(rawRows)
        ? (rawRows[0] as Record<string, unknown> | undefined)
        : undefined;
      const rp = row?.["recovery_point"];
      return typeof rp === "string" && RECOVERY_POINT_SET.has(rp)
        ? (rp as RecoveryPoint)
        : null;
    });
  }

  /**
   * Delete stale non-completed keys older than 72 h across all workspaces.
   *
   * This is a cross-workspace maintenance operation (cron `mnemo.idempotency.reap`).
   * The 72 h TTL mirrors RedisIdempotencyStore (IDP_TTL_SECONDS = 259_200).
   *
   * RLS note: mnemo_idempotency_keys has FORCE ROW LEVEL SECURITY. Migration 0072
   * adds a permissive RLS policy (mnemo_idempotency_reap) scoped to mnemo_app_role
   * that covers ALL commands (SELECT + DELETE). SELECT coverage is required because
   * PG17 enforces SELECT visibility before a row can be the target of a DELETE — a
   * DELETE-only policy alone is insufficient. The policy USING condition is narrow
   * (non-completed AND > 72 h old), so fresh/completed rows still require the
   * workspace GUC via the ws_isolation policy. No superuser or BYPASSRLS needed.
   */
  async reap(): Promise<{ reaped: number }> {
    const deleted = await this.db.execute(sql`
      DELETE FROM mnemosyne.mnemo_idempotency_keys
      WHERE recovery_point <> 'completed'
        AND created_at < now() - interval '72 hours'
      RETURNING key
    `);
    return { reaped: Array.from(deleted).length };
  }
}
