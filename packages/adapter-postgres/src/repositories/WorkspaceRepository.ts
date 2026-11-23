import { sql } from "drizzle-orm";
import postgres from "postgres";
import type { DrizzleClient } from "./types.js";
import { instrumentedQuery } from "./mappers.js";
import type { HealthStatus } from "@mnemo-ai/types";

export class WorkspaceRepository {
  constructor(
    private readonly db: DrizzleClient,
    private readonly pgClient: postgres.Sql | null
  ) {}

  async getWorkspaceMode(workspaceId: string): Promise<{
    mode: "learning" | "production";
    sessionCount: number;
    promoteAt: number | null;
    startedAt?: Date;
    factCount?: number;
    entityCount?: number;
  } | null> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      const rows = await tx.execute<{
        mode: "learning" | "production";
        session_count: number;
        promote_at: number | null;
        started_at: Date;
        fact_count: number;
        entity_count: number;
      }>(sql`
        SELECT m.mode, m.session_count, m.promote_at, m.started_at, m.fact_count,
               -- Graduation counts the entities alive right now (valid_to IS NULL), not the
               -- stored counter: nothing writes entity_count, so it stayed at 0 forever.
               (SELECT count(*)::int FROM mnemosyne.mnemo_entity e
                 WHERE e.workspace_id = m.workspace_id AND e.valid_to IS NULL) AS entity_count
        FROM mnemosyne.mnemo_workspace_mode m
        WHERE m.workspace_id = ${workspaceId}
        LIMIT 1
      `);
      const r = rows[0];
      if (!r) return null;
      return {
        mode: r.mode,
        sessionCount: r.session_count,
        promoteAt: r.promote_at ?? null,
        startedAt: new Date(r.started_at),
        factCount: r.fact_count,
        entityCount: r.entity_count,
      };
    });
  }

  async setWorkspaceMode(
    workspaceId: string,
    patch: {
      mode?: "learning" | "production";
      sessionCount?: number;
      promoteAt?: number | null;
      factCount?: number;
      entityCount?: number;
    }
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      await tx.execute(sql`
        INSERT INTO mnemosyne.mnemo_workspace_mode
          (workspace_id, mode, session_count, promote_at, fact_count, entity_count, updated_at)
        VALUES (
          ${workspaceId},
          ${patch.mode ?? "learning"},
          ${patch.sessionCount ?? 0},
          ${patch.promoteAt ?? null},
          ${patch.factCount ?? 0},
          ${patch.entityCount ?? 0},
          NOW()
        )
        ON CONFLICT (workspace_id) DO UPDATE SET
          mode          = COALESCE(${patch.mode ?? null}, mnemo_workspace_mode.mode),
          session_count = COALESCE(${patch.sessionCount ?? null}::int, mnemo_workspace_mode.session_count),
          promote_at    = ${patch.promoteAt === undefined ? sql`mnemo_workspace_mode.promote_at` : patch.promoteAt},
          fact_count    = COALESCE(${patch.factCount ?? null}::int, mnemo_workspace_mode.fact_count),
          entity_count  = COALESCE(${patch.entityCount ?? null}::int, mnemo_workspace_mode.entity_count),
          updated_at    = NOW()
      `);
    });
  }

  async incrementWorkspaceModeCounters(
    workspaceId: string,
    delta: {
      factCount?: number;
      entityCount?: number;
      sessionCount?: number;
    }
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      await tx.execute(sql`
        INSERT INTO mnemosyne.mnemo_workspace_mode
          (workspace_id, mode, session_count, fact_count, entity_count, updated_at)
        VALUES (${workspaceId}, 'learning', ${delta.sessionCount ?? 0}, ${delta.factCount ?? 0}, ${delta.entityCount ?? 0}, NOW())
        ON CONFLICT (workspace_id) DO UPDATE SET
          session_count = mnemo_workspace_mode.session_count + ${delta.sessionCount ?? 0},
          fact_count    = mnemo_workspace_mode.fact_count    + ${delta.factCount ?? 0},
          entity_count  = mnemo_workspace_mode.entity_count  + ${delta.entityCount ?? 0},
          updated_at    = NOW()
      `);
    });
  }

  // ── RDD-4: Per-turn dedup gate ────────────────────────────────────────────────
  // Used by collapse.ts to skip re-writing knowledge that was already extracted
  // per-turn — prevents the same fact being written twice (once per-turn, once at collapse).

  async listSessionTopicKeysBySource(
    workspaceId: string,
    sessionId: string,
    source: string
  ): Promise<string[]> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      // mnemo_fact.workspace_id and session_id are TEXT columns — compare as
      // text (no ::uuid cast). The GUC set via mnemo_set_workspace still casts
      // to uuid because that function's signature requires it.
      const rows = await tx.execute<{ topic_key: string }>(sql`
        SELECT DISTINCT topic_key
        FROM mnemosyne.mnemo_fact
        WHERE workspace_id = ${workspaceId}
          AND session_id   = ${sessionId}
          AND extraction_source = ${source}
          AND topic_key IS NOT NULL
      `);
      return rows.map((r) => r.topic_key);
    });
  }

  async listWorkspaceIds(): Promise<string[]> {
    return instrumentedQuery("admin", async () => {
      // Active facts are not the only reason a workspace needs per-workspace work.
      // A workspace can hold captured managed transcripts and no knowledge at all —
      // nothing extracted yet, or everything forgotten — and enumerating on facts
      // alone made it invisible to the very job that must delete those transcripts.
      //
      // A managed session counts while it is still unfinished, or while it still
      // has turns to purge; once it is terminal and drained it stops keeping the
      // workspace in the rotation.
      //
      // The query lives in a SECURITY DEFINER function (migration 0041): there is
      // no workspace to set the RLS GUC to, so run as the application role it
      // saw no rows at all and every per-workspace job iterated nothing.
      const rows = await this.db.execute<{ workspace_id: string }>(
        sql`SELECT workspace_id FROM mnemosyne.mnemo_list_workspace_ids() AS workspace_id`
      );
      return Array.from(rows).map((r) => r.workspace_id);
    });
  }

  async listDueReminderWorkspaceIds(): Promise<string[]> {
    return instrumentedQuery("admin", async () => {
      const rows = await this.db.execute<{ workspace_id: string }>(
        sql`SELECT workspace_id FROM mnemosyne.mnemo_list_due_reminder_workspace_ids() AS workspace_id`
      );
      return Array.from(rows).map((r) => r.workspace_id);
    });
  }

  async healthCheck(): Promise<HealthStatus> {
    const start = Date.now();
    try {
      await this.db.execute(sql`SELECT 1`);
      return { status: "ok", latencyMs: Date.now() - start };
    } catch (e) {
      return { status: "down", latencyMs: Date.now() - start, detail: String(e) };
    }
  }

  async close(): Promise<void> {
    if (this.pgClient) {
      await this.pgClient.end();
    }
  }

  // ─── Raw SQL execution (partition lifecycle cron) ──────────────────────────

  /**
   * Execute a parameterless raw SQL string and return the result rows.
   * Used exclusively by the audit-partition cron (mnemo.audit.partition) to
   * call the migration-0062 plpgsql functions without coupling the cron
   * handler to a specific DB driver.
   *
   * Must not accept user-supplied input — the cron handler only passes
   * hard-coded SQL strings calling known Postgres functions.
   */
  async runSql(query: string): Promise<Array<Record<string, unknown>>> {
    const rows = await this.db.execute<Record<string, unknown>>(sql.raw(query));
    return rows as Array<Record<string, unknown>>;
  }
}
