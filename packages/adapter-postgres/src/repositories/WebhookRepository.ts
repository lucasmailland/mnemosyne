import { eq, and, or, isNull, lte, sql, inArray, asc } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import { dbNow } from "./_clock.js";
import * as schema from "../schema/index.js";
import { mapRowToWebhookEndpoint, mapRowToWebhookDelivery, mapRowToReminder } from "./mappers.js";
import type { DrizzleClient } from "./types.js";
import type {
  MnemoWebhookEndpoint,
  MnemoWebhookDelivery,
  CreateWebhookEndpointInput,
  UpdateWebhookEndpointInput,
  CreateWebhookDeliveryInput,
  MnemoReminder,
  CreateReminderInput,
} from "@mnemo-ai/types";

export class WebhookRepository {
  constructor(
    private readonly db: DrizzleClient,
    private readonly readDb: DrizzleClient
  ) {}

  // WEBHOOK-1: every method below that has a workspaceId now sets the RLS GUC
  // (mnemo_set_workspace) inside its own transaction before touching
  // mnemo_webhook_endpoint/mnemo_webhook_delivery, matching the pattern every
  // other repository in this codebase already follows (EventRepository,
  // KnowledgeRepository, etc.). Before this fix, NONE of these methods set
  // it — under a real NOSUPERUSER FORCE-RLS role, `mnemo_webhook_endpoint`'s
  // `mnemo_webhook_endpoint_workspace_isolation` policy (USING
  // current_setting('mnemosyne.workspace_id') with NO missing_ok flag) threw
  // `unrecognized configuration parameter` on every query, masked until now
  // by the column-drift bug fixed in migration 0020 (the column error fired
  // first, at parse time, before RLS ever got a chance to evaluate).

  async createWebhookEndpoint(input: CreateWebhookEndpointInput): Promise<MnemoWebhookEndpoint> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${input.workspaceId}::uuid)`);
      const rows = await tx
        .insert(schema.webhookEndpointTable)
        .values({
          id: input.id,
          workspaceId: input.workspaceId,
          url: input.url,
          events: input.events,
          secretHash: input.secretHash,
          isActive: true,
          description: input.description ?? null,
        })
        .returning();
      return mapRowToWebhookEndpoint(rows[0]!);
    });
  }

  async getWebhookEndpoint(id: string, workspaceId: string): Promise<MnemoWebhookEndpoint | null> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      const rows = await tx
        .select()
        .from(schema.webhookEndpointTable)
        .where(
          and(
            eq(schema.webhookEndpointTable.id, id),
            eq(schema.webhookEndpointTable.workspaceId, workspaceId)
          )
        )
        .limit(1);
      return rows.length > 0 ? mapRowToWebhookEndpoint(rows[0]!) : null;
    });
  }

  async listWebhookEndpoints(workspaceId: string): Promise<MnemoWebhookEndpoint[]> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      const rows = await tx
        .select()
        .from(schema.webhookEndpointTable)
        .where(eq(schema.webhookEndpointTable.workspaceId, workspaceId));
      return rows.map(mapRowToWebhookEndpoint);
    });
  }

  async updateWebhookEndpoint(
    id: string,
    workspaceId: string,
    input: UpdateWebhookEndpointInput
  ): Promise<MnemoWebhookEndpoint> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      // created_at is DEFAULT now(): the bump comes from the same clock.
      const updates: PgUpdateSetSource<typeof schema.webhookEndpointTable> = {
        updatedAt: dbNow(),
      };
      if (input.url !== undefined) updates.url = input.url;
      if (input.events !== undefined) updates.events = input.events;
      if (input.isActive !== undefined) updates.isActive = input.isActive;
      if (input.description !== undefined) updates.description = input.description;
      if (input.failureCount !== undefined) updates.failureCount = input.failureCount;
      if (input.disabledAt !== undefined) updates.disabledAt = input.disabledAt;

      const rows = await tx
        .update(schema.webhookEndpointTable)
        .set(updates)
        // WEBHOOK-1: workspace_id added to the WHERE as defense-in-depth —
        // previously this UPDATE had no workspace scoping of its own at
        // all (relied entirely on RLS, which was never even active here).
        .where(
          and(
            eq(schema.webhookEndpointTable.id, id),
            eq(schema.webhookEndpointTable.workspaceId, workspaceId)
          )
        )
        .returning();
      return mapRowToWebhookEndpoint(rows[0]!);
    });
  }

  async deleteWebhookEndpoint(id: string, workspaceId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      await tx
        .delete(schema.webhookEndpointTable)
        .where(
          and(
            eq(schema.webhookEndpointTable.id, id),
            eq(schema.webhookEndpointTable.workspaceId, workspaceId)
          )
        );
    });
  }

  async recordWebhookDelivery(entry: CreateWebhookDeliveryInput): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${entry.workspaceId}::uuid)`);
      await tx.insert(schema.webhookDeliveryTable).values({
        id: entry.id,
        webhookId: entry.webhookId,
        workspaceId: entry.workspaceId,
        eventType: entry.eventType,
        payload: entry.payload,
        status: entry.status,
        responseStatus: entry.responseStatus ?? null,
        responseBody: entry.responseBody ?? null,
        attempt: entry.attempt ?? 1,
        deliveredAt: entry.deliveredAt ?? null,
      });
    });
  }

  async listWebhookDeliveries(
    webhookId: string,
    workspaceId: string,
    limit = 50
  ): Promise<MnemoWebhookDelivery[]> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      const rows = await tx
        .select()
        .from(schema.webhookDeliveryTable)
        .where(
          and(
            eq(schema.webhookDeliveryTable.webhookId, webhookId),
            eq(schema.webhookDeliveryTable.workspaceId, workspaceId)
          )
        )
        .orderBy(sql`${schema.webhookDeliveryTable.createdAt} DESC`)
        .limit(limit);
      return rows.map(mapRowToWebhookDelivery);
    });
  }

  /**
   * WEBHOOK-2 — FIXED. This is the one webhook method that is INTENTIONALLY
   * cross-workspace — the delivery-worker cron
   * (`packages/server/src/cron/webhookDelivery.ts`) polls pending deliveries
   * across ALL workspaces in one batch. That access pattern is fundamentally
   * at odds with per-workspace FORCE RLS: there is no single `workspaceId`
   * to set the GUC to here, and `mnemo_webhook_delivery`'s RLS policy
   * (`mnemo_webhook_delivery_workspace_isolation`) has no `missing_ok` flag
   * on its `current_setting()` call — so a direct query threw `unrecognized
   * configuration parameter "mnemosyne.workspace_id"` on every poll cycle.
   *
   * Fixed via `mnemosyne.mnemo_claim_pending_webhook_deliveries()`
   * (migration 0021), a SECURITY DEFINER function — the same mechanism
   * this codebase already uses for `mnemo_refresh_anticipation()`. The
   * function body executes as its owner (bypasses RLS entirely, same as a
   * superuser), so this ONE narrowly-scoped read legitimately sees pending
   * deliveries across every workspace, while every other access path to
   * this table (recordWebhookDelivery, listWebhookDeliveries,
   * updateWebhookDelivery — all workspace-scoped and GUC-fixed by
   * WEBHOOK-1) keeps real per-workspace RLS isolation intact. Deliberately
   * NOT "disable RLS on the table" (the `mnemo_outbox` precedent for
   * cross-tenant workers) — that would have removed workspace isolation
   * from the correctly-scoped per-request paths too.
   *
   * Raw `sql` execute, not the Drizzle query builder: the function returns
   * `SETOF mnemo_webhook_delivery`, whose columns come back snake_case
   * (no `postgres.camel` transform configured on this client — see
   * `createDrizzleClient`), so the mapping below is manual, mirroring the
   * pattern already used for raw MV reads in `AnalyticsRepository.ts`.
   */
  async listPendingWebhookDeliveries(limit: number): Promise<MnemoWebhookDelivery[]> {
    const rows = (await this.db.execute(sql`
      SELECT * FROM mnemosyne.mnemo_claim_pending_webhook_deliveries(${limit})
    `)) as unknown as Array<{
      id: string;
      webhook_id: string;
      workspace_id: string;
      event_type: string;
      payload: Record<string, unknown> | null;
      status: string;
      response_status: number | null;
      response_body: string | null;
      attempt: number;
      delivered_at: string | Date | null;
      next_attempt_at: string | Date | null;
      created_at: string | Date;
    }>;
    return rows.map((r) => ({
      id: r.id,
      webhookId: r.webhook_id,
      workspaceId: r.workspace_id,
      eventType: r.event_type,
      payload: r.payload ?? {},
      status: r.status as MnemoWebhookDelivery["status"],
      responseStatus: r.response_status ?? null,
      responseBody: r.response_body ?? null,
      attempt: r.attempt,
      deliveredAt: r.delivered_at ? new Date(r.delivered_at) : null,
      nextAttemptAt: r.next_attempt_at ? new Date(r.next_attempt_at) : null,
      createdAt: r.created_at instanceof Date ? r.created_at : new Date(r.created_at),
    }));
  }

  async updateWebhookDelivery(
    id: string,
    workspaceId: string,
    update: {
      status?: "pending" | "delivered" | "failed";
      responseStatus?: number;
      responseBody?: string;
      attempt?: number;
      deliveredAt?: Date;
      nextAttemptAt?: Date | null;
    }
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      const updates: Partial<schema.InsertWebhookDelivery> = {};
      if (update.status !== undefined) updates.status = update.status;
      if (update.responseStatus !== undefined) updates.responseStatus = update.responseStatus;
      if (update.responseBody !== undefined) updates.responseBody = update.responseBody;
      if (update.attempt !== undefined) updates.attempt = update.attempt;
      if (update.deliveredAt !== undefined) updates.deliveredAt = update.deliveredAt;
      if (update.nextAttemptAt !== undefined) updates.nextAttemptAt = update.nextAttemptAt;

      await tx
        .update(schema.webhookDeliveryTable)
        .set(updates)
        .where(
          and(
            eq(schema.webhookDeliveryTable.id, id),
            eq(schema.webhookDeliveryTable.workspaceId, workspaceId)
          )
        );
    });
  }

  // ─── Prospective memory (reminders) ─────────────────────────────────────────

  async createReminder(input: CreateReminderInput): Promise<MnemoReminder> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${input.workspaceId}::uuid)`);

      const rows = await tx
        .insert(schema.reminderTable)
        .values({
          id: input.id,
          workspaceId: input.workspaceId,
          content: input.content,
          condition: input.condition ?? null,
          triggerAt: input.triggerAt ?? null,
          status: "pending",
          conditionEmbedding:
            (input.conditionEmbedding as unknown as schema.InsertReminder["conditionEmbedding"]) ??
            null,
          createdByAgentId: input.createdByAgentId ?? null,
          actorId: input.actorId ?? null,
          userId: input.userId ?? null,
          actorType: input.actorType ?? null,
        })
        .returning();

      return mapRowToReminder(rows[0]!);
    });
  }

  async getReminder(id: string, workspaceId: string): Promise<MnemoReminder | null> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);

      const rows = await tx
        .select()
        .from(schema.reminderTable)
        .where(
          and(eq(schema.reminderTable.id, id), eq(schema.reminderTable.workspaceId, workspaceId))
        )
        .limit(1);

      return rows[0] ? mapRowToReminder(rows[0]) : null;
    });
  }

  async listPendingReminders(workspaceId: string, asOf: Date): Promise<MnemoReminder[]> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);

      const rows = await tx
        .select()
        .from(schema.reminderTable)
        .where(
          and(
            eq(schema.reminderTable.workspaceId, workspaceId),
            eq(schema.reminderTable.status, "pending"),
            // REMIND-1 fix: typed or(isNull(...), lte(...)) — NOT a raw `sql`
            // template embedding a bare JS Date. Same DATEBUG family bug as
            // SKILL-1's querySkills: a raw Date interpolated into `sql`
            // skips Drizzle's column-aware driver-value mapping and
            // postgres.js rejects the parameter. This one was never caught
            // before because nothing exercised listPendingReminders against
            // a real Postgres with a real trigger_at value until REMIND-1's
            // integration test.
            or(isNull(schema.reminderTable.triggerAt), lte(schema.reminderTable.triggerAt, asOf))!
          )
        );

      return rows.map(mapRowToReminder);
    });
  }

  async dismissReminder(
    id: string,
    workspaceId: string,
    newStatus: "triggered" | "dismissed"
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);

      const now = new Date();
      await tx
        .update(schema.reminderTable)
        .set({
          status: newStatus,
          triggeredAt: newStatus === "triggered" ? now : null,
          dismissedAt: newStatus === "dismissed" ? now : null,
          updatedAt: now,
        })
        .where(
          and(eq(schema.reminderTable.id, id), eq(schema.reminderTable.workspaceId, workspaceId))
        );
    });
  }

  async listReminders(
    workspaceId: string,
    status: "pending" | "triggered" | "dismissed" | "all",
    limit: number
  ): Promise<MnemoReminder[]> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);

      const conditions = [eq(schema.reminderTable.workspaceId, workspaceId)];
      if (status !== "all") {
        conditions.push(eq(schema.reminderTable.status, status));
      }

      const rows = await tx
        .select()
        .from(schema.reminderTable)
        .where(and(...conditions))
        .orderBy(sql`${schema.reminderTable.createdAt} DESC`)
        .limit(limit);

      return rows.map(mapRowToReminder);
    });
  }

  /**
   * LIFECYCLE-6 — see ReminderPort.claimUndeliveredReminders. Each UPDATE
   * re-checks `delivered_at IS NULL` on the locked row, so a concurrent claim
   * that got there first leaves this one with zero rows for it; the backlog
   * subquery skips rows another claim holds instead of waiting on them.
   */
  async claimUndeliveredReminders(
    workspaceId: string,
    input: { ids: string[]; limit: number }
  ): Promise<MnemoReminder[]> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      const now = new Date();
      const claimable = and(
        eq(schema.reminderTable.workspaceId, workspaceId),
        eq(schema.reminderTable.status, "triggered"),
        isNull(schema.reminderTable.deliveredAt)
      );
      const own =
        input.ids.length > 0
          ? await tx
              .update(schema.reminderTable)
              .set({ deliveredAt: now })
              .where(and(claimable, inArray(schema.reminderTable.id, input.ids)))
              .returning()
          : [];
      const backlog =
        input.limit > 0
          ? await tx
              .update(schema.reminderTable)
              .set({ deliveredAt: now })
              .where(
                and(
                  claimable,
                  inArray(
                    schema.reminderTable.id,
                    tx
                      .select({ id: schema.reminderTable.id })
                      .from(schema.reminderTable)
                      .where(claimable)
                      .orderBy(asc(schema.reminderTable.triggeredAt), asc(schema.reminderTable.id))
                      .limit(input.limit)
                      .for("update", { skipLocked: true })
                  )
                )
              )
              .returning()
          : [];
      const byTrigger = (a: { triggeredAt: Date | null }, b: { triggeredAt: Date | null }) =>
        (a.triggeredAt?.getTime() ?? 0) - (b.triggeredAt?.getTime() ?? 0);
      return [...own.sort(byTrigger), ...backlog.sort(byTrigger)].map(mapRowToReminder);
    });
  }
}
