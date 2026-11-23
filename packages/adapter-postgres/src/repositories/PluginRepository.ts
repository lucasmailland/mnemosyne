import { eq, and, sql } from 'drizzle-orm';
import * as schema from '../schema/index.js';
import type { DrizzleClient } from './types.js';

export class PluginRepository {
  constructor(
    private readonly db: DrizzleClient,
    private readonly readDb: DrizzleClient,
  ) {}

  // ── §21 Plugin state persistence (Wave U) ────────────────────────────────

  async getPluginState(workspaceId: string, pluginId: string): Promise<Record<string, unknown> | null> {
    const rows = await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      return tx.select({ state: schema.pluginStateTable.state })
        .from(schema.pluginStateTable)
        .where(
          and(
            eq(schema.pluginStateTable.workspaceId, workspaceId),
            eq(schema.pluginStateTable.pluginId, pluginId),
          ),
        )
        .limit(1);
    });
    if (!rows.length) return null;
    return (rows[0]!.state as Record<string, unknown>) ?? null;
  }

  async upsertPluginState(workspaceId: string, pluginId: string, state: Record<string, unknown>): Promise<void> {
    const id = `${workspaceId}:${pluginId}`;
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      await tx.execute(sql`
        INSERT INTO mnemosyne.mnemo_plugin_state (id, workspace_id, plugin_id, state, created_at, updated_at)
        VALUES (
          ${id},
          ${workspaceId},
          ${pluginId},
          ${JSON.stringify(state)}::jsonb,
          NOW(),
          NOW()
        )
        ON CONFLICT (id) DO UPDATE
          SET state = excluded.state, updated_at = NOW()
      `);
    });
  }

  async deletePluginStateKey(workspaceId: string, pluginId: string, key: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      await tx.execute(sql`
        UPDATE mnemosyne.mnemo_plugin_state
        SET state = state - ${key}, updated_at = NOW()
        WHERE workspace_id = ${workspaceId}
          AND plugin_id = ${pluginId}
      `);
    });
  }

  // ── §14 Prompt version CRUD (Wave U U2.3) ──────────────────────────────────

  async createPromptVersion(input: {
    workspaceId: string;
    agentId: string;
    promptText: string;
    diffFromPrevious: string;
    algorithm: string;
    trajectoriesUsed: number;
    avgScoreBefore: number | null;
    avgScoreAfter: number | null;
    status: "candidate";
  }): Promise<{ id: string }> {
    const id = `pv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${input.workspaceId}::uuid)`);
      // Monotonic version per (workspace_id, prompt_key) — avoids unique violation
      // when a second candidate is created for the same agent (A/B loop).
      const [vRow] = await tx.execute<{ next_version: number }>(sql`
        SELECT COALESCE(MAX(version), 0) + 1 AS next_version
        FROM mnemosyne.mnemo_prompt_version
        WHERE workspace_id = ${input.workspaceId}
          AND prompt_key = ${input.agentId}
      `);
      const nextVersion = (vRow as { next_version: number }).next_version ?? 1;
      await tx.insert(schema.promptVersionTable).values({
        id,
        workspaceId: input.workspaceId,
        promptKey: input.agentId,
        version: nextVersion,
        content: input.promptText ?? "",
        agentId: input.agentId,
        promptText: input.promptText,
        diffFromPrevious: input.diffFromPrevious,
        algorithm: input.algorithm,
        trajectoriesUsed: input.trajectoriesUsed,
        avgScoreBefore: input.avgScoreBefore ?? undefined,
        avgScoreAfter: input.avgScoreAfter ?? undefined,
        status: input.status,
        isActive: false,
      });
    });
    return { id };
  }

  async getActivePromptVersion(
    workspaceId: string,
    agentId: string,
  ): Promise<{
    id: string;
    status: "candidate" | "testing" | "active" | "rolled_back";
    trajectoriesUsed: number | null;
    avgScoreBefore: number | null;
    avgScoreAfter: number | null;
  } | null> {
    const rows = await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      return tx
        .select({
          id: schema.promptVersionTable.id,
          status: schema.promptVersionTable.status,
          trajectoriesUsed: schema.promptVersionTable.trajectoriesUsed,
          avgScoreBefore: schema.promptVersionTable.avgScoreBefore,
          avgScoreAfter: schema.promptVersionTable.avgScoreAfter,
        })
        .from(schema.promptVersionTable)
        .where(
          and(
            eq(schema.promptVersionTable.workspaceId, workspaceId),
            eq(schema.promptVersionTable.agentId, agentId),
            sql`${schema.promptVersionTable.status} IN ('candidate', 'testing', 'active')`,
          ),
        )
        .orderBy(sql`${schema.promptVersionTable.createdAt} DESC`)
        .limit(1);
    });
    if (!rows.length) return null;
    const row = rows[0]!;
    return {
      id: row.id,
      status: row.status as "candidate" | "testing" | "active" | "rolled_back",
      trajectoriesUsed: row.trajectoriesUsed ?? null,
      avgScoreBefore: row.avgScoreBefore ?? null,
      avgScoreAfter: row.avgScoreAfter ?? null,
    };
  }

  async listPromptVersions(
    workspaceId: string,
    agentId: string,
  ): Promise<
    Array<{
      id: string;
      promptText: string | null;
      diffFromPrevious: string | null;
      algorithm: string;
      status: string;
      trajectoriesUsed: number | null;
      avgScoreBefore: number | null;
      avgScoreAfter: number | null;
      activatedAt: Date | null;
      createdAt: Date;
    }>
  > {
    const rows = await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      return tx
        .select({
          id: schema.promptVersionTable.id,
          promptText: schema.promptVersionTable.promptText,
          diffFromPrevious: schema.promptVersionTable.diffFromPrevious,
          algorithm: schema.promptVersionTable.algorithm,
          status: schema.promptVersionTable.status,
          trajectoriesUsed: schema.promptVersionTable.trajectoriesUsed,
          avgScoreBefore: schema.promptVersionTable.avgScoreBefore,
          avgScoreAfter: schema.promptVersionTable.avgScoreAfter,
          activatedAt: schema.promptVersionTable.activatedAt,
          createdAt: schema.promptVersionTable.createdAt,
        })
        .from(schema.promptVersionTable)
        .where(
          and(
            eq(schema.promptVersionTable.workspaceId, workspaceId),
            eq(schema.promptVersionTable.agentId, agentId),
          ),
        )
        .orderBy(sql`${schema.promptVersionTable.createdAt} DESC`);
    });
    return rows.map((r) => ({
      id: r.id,
      promptText: r.promptText ?? null,
      diffFromPrevious: r.diffFromPrevious ?? null,
      algorithm: r.algorithm,
      status: r.status,
      trajectoriesUsed: r.trajectoriesUsed ?? null,
      avgScoreBefore: r.avgScoreBefore ?? null,
      avgScoreAfter: r.avgScoreAfter ?? null,
      activatedAt: r.activatedAt ?? null,
      createdAt: r.createdAt,
    }));
  }

  async transitionPromptVersion(
    workspaceId: string,
    promptVersionId: string,
    newStatus: "testing" | "active" | "rolled_back",
    avgScoreAfter: number,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      await tx.execute(sql`
        UPDATE mnemosyne.mnemo_prompt_version
        SET
          status          = ${newStatus},
          avg_score_after = ${avgScoreAfter},
          activated_at    = CASE WHEN ${newStatus} = 'active' THEN NOW() ELSE activated_at END
        WHERE workspace_id = ${workspaceId}
          AND id           = ${promptVersionId}
      `);
    });
  }

  // ── §14 Procedural memory — list scored trajectories (sessions with outcomeRating) ──

  async listScoredTrajectories(
    workspaceId: string,
    agentId: string,
    limit: number,
  ): Promise<Array<{ sessionId: string; score: number; promptVersionId: string | null; createdAt: Date }>> {
    const rows = await this.db.execute<{
      id: string;
      outcome_rating: string | null;
      active_prompt_version_id: string | null;
      started_at: Date;
    }>(sql`
      SELECT id, outcome_rating, active_prompt_version_id, started_at
      FROM mnemosyne.mnemo_session
      WHERE workspace_id = ${workspaceId}
        AND outcome_rating IS NOT NULL
        ${agentId !== "*" ? sql`AND agent_id = ${agentId}` : sql``}
      ORDER BY started_at DESC
      LIMIT ${limit}
    `);
    return rows.map((r) => ({
      sessionId: r.id,
      score:
        r.outcome_rating === "success" ? 1.0
        : r.outcome_rating === "failure" ? 0.0
        : 0.5,
      promptVersionId: r.active_prompt_version_id ?? null,
      createdAt: new Date(r.started_at),
    }));
  }
}
