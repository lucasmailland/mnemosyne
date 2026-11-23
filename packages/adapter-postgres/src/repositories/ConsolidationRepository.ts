import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

import type {
  ApplyConsolidationMergeInput,
  ConsolidationMergeSnapshot,
  ConsolidationWorthSnapshot,
  ReplayFailureReview,
} from "@mnemo-ai/types";
import type { DrizzleClient } from "./types.js";

const PENDING_KEY = "__mnemoConsolidationPending";

type ConsolidationTx = Parameters<Parameters<DrizzleClient["transaction"]>[0]>[0];

interface FactRow {
  id: string;
  workspace_id: string;
  status: string;
  valid_to: Date | null;
  merged_into_id?: string | null;
  metadata: Record<string, unknown>;
  worth_alpha: string | number;
  worth_beta: string | number;
  worth_success: string | number;
  worth_failure: string | number;
}

interface ConsolidationMarker extends ConsolidationMergeSnapshot {
  leaseExpiresAt: string;
}

function rowsOf<T>(value: unknown): T[] {
  return Array.from(value as Iterable<T>);
}

function worthOf(row: FactRow): ConsolidationWorthSnapshot {
  return {
    alpha: Number(row.worth_alpha),
    beta: Number(row.worth_beta),
    success: Number(row.worth_success),
    failure: Number(row.worth_failure),
  };
}

function worthEquals(row: FactRow, worth: ConsolidationWorthSnapshot): boolean {
  const actual = worthOf(row);
  return (
    actual.alpha === worth.alpha &&
    actual.beta === worth.beta &&
    actual.success === worth.success &&
    actual.failure === worth.failure
  );
}

function markerOf(row: FactRow): ConsolidationMarker | undefined {
  const marker = row.metadata?.[PENDING_KEY];
  return marker && typeof marker === "object" ? (marker as ConsolidationMarker) : undefined;
}

function participantIds(snapshot: ConsolidationMergeSnapshot): string[] {
  return [snapshot.survivorId, ...snapshot.absorbedFactIds].sort();
}

function idList(ids: string[]) {
  return sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `
  );
}

function pendingRows(snapshot: ConsolidationMergeSnapshot, rows: FactRow[]): boolean {
  if (
    rows.length !== participantIds(snapshot).length ||
    !rows.every((row) => markerOf(row)?.operationId === snapshot.operationId)
  )
    return false;
  const survivor = rows.find((row) => row.id === snapshot.survivorId);
  const absorbed = rows.filter((row) => row.id !== snapshot.survivorId);
  return (
    !!survivor &&
    survivor.status === "active" &&
    survivor.valid_to == null &&
    worthEquals(survivor, snapshot.expectedMergedWorth) &&
    absorbed.length === snapshot.absorbedFactIds.length &&
    absorbed.every(
      (row) =>
        row.status === "merged" &&
        row.valid_to != null &&
        row.merged_into_id === snapshot.survivorId
    )
  );
}

export class ConsolidationRepository {
  constructor(private readonly db: DrizzleClient) {}

  private async withWorkspace<T>(
    workspaceId: string,
    fn: (tx: ConsolidationTx) => Promise<T>
  ): Promise<T> {
    return this.db.transaction(async (tx) => {
      const memberRows = rowsOf<{ m?: boolean }>(
        await tx.execute(sql`SELECT pg_has_role(current_user, 'app_user', 'member') AS m`)
      );
      if (memberRows[0]?.m) {
        await tx.execute(sql`SET LOCAL ROLE app_user`);
      } else {
        const roles = rowsOf<{ rolsuper?: boolean; rolbypassrls?: boolean }>(
          await tx.execute(
            sql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
          )
        );
        if (!roles[0] || roles[0].rolsuper || roles[0].rolbypassrls) {
          throw new Error("[SECURITY] Unsafe database role cannot enforce workspace RLS");
        }
      }
      await tx.execute(sql`SET LOCAL search_path TO mnemosyne, public`);
      await tx.execute(sql`SELECT set_config('app.workspace_id', ${workspaceId}, true)`);
      await tx.execute(sql`SELECT set_config('mnemosyne.workspace_id', ${workspaceId}, true)`);
      return fn(tx);
    });
  }

  private async lockRows(
    tx: ConsolidationTx,
    snapshot: ConsolidationMergeSnapshot
  ): Promise<FactRow[]> {
    const ids = participantIds(snapshot);
    return rowsOf<FactRow>(
      await tx.execute(sql`
      SELECT id, workspace_id, status, valid_to, merged_into_id, metadata,
             worth_alpha, worth_beta, worth_success, worth_failure
      FROM mnemosyne.mnemo_fact
      WHERE workspace_id = ${snapshot.workspaceId}
        AND id IN (${idList(ids)})
      ORDER BY id FOR UPDATE
    `)
    );
  }

  async applyConsolidationMerge(
    input: ApplyConsolidationMergeInput
  ): Promise<ConsolidationMergeSnapshot | null> {
    return this.withWorkspace(input.workspaceId, async (tx) => {
      const ids = [input.survivorId, ...input.absorbedFactIds].sort();
      if (input.absorbedFactIds.length === 0 || new Set(ids).size !== ids.length) return null;
      const rows = rowsOf<FactRow>(
        await tx.execute(sql`
        SELECT id, workspace_id, status, valid_to, merged_into_id, metadata,
               worth_alpha, worth_beta, worth_success, worth_failure
        FROM mnemosyne.mnemo_fact
        WHERE workspace_id = ${input.workspaceId}
          AND id IN (${idList(ids)})
        ORDER BY id FOR UPDATE
      `)
      );
      const eligible =
        rows.length === ids.length &&
        rows.every(
          (row) =>
            row.workspace_id === input.workspaceId &&
            row.status === "active" &&
            row.valid_to == null &&
            !Object.prototype.hasOwnProperty.call(row.metadata ?? {}, PENDING_KEY)
        );
      const survivors = rows.filter((row) => row.id === input.survivorId);
      const rowIds = new Set(rows.map((row) => row.id));
      if (
        !eligible ||
        survivors.length !== 1 ||
        input.absorbedFactIds.some((id) => !rowIds.has(id))
      )
        return null;

      const previousWorth = worthOf(survivors[0]!);
      const expectedMergedWorth = {
        ...previousWorth,
        alpha: previousWorth.alpha + 1,
        success: previousWorth.success + 1,
      };
      const snapshot: ConsolidationMergeSnapshot = {
        operationId: input.operationId,
        workspaceId: input.workspaceId,
        survivorId: input.survivorId,
        absorbedFactIds: [...input.absorbedFactIds],
        previousWorth,
        expectedMergedWorth,
      };
      const marker: ConsolidationMarker = {
        ...snapshot,
        leaseExpiresAt: input.leaseExpiresAt.toISOString(),
      };
      const updated = rowsOf<{ id: string }>(
        await tx.execute(sql`
        UPDATE mnemosyne.mnemo_fact
        SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{${sql.raw(PENDING_KEY)}}', ${JSON.stringify(marker)}::jsonb, true),
            status = CASE WHEN id = ${input.survivorId} THEN status ELSE 'merged' END,
            merged_into_id = CASE WHEN id = ${input.survivorId} THEN merged_into_id ELSE ${input.survivorId} END,
            -- Rows are resolved under a lock: one created after this transaction
            -- began starts after transaction_timestamp() (_clock.ts).
            valid_to = CASE WHEN id = ${input.survivorId} THEN valid_to ELSE GREATEST(transaction_timestamp(), valid_from) END,
            worth_alpha = CASE WHEN id = ${input.survivorId} THEN ${expectedMergedWorth.alpha}::numeric ELSE worth_alpha END,
            worth_beta = CASE WHEN id = ${input.survivorId} THEN ${expectedMergedWorth.beta}::numeric ELSE worth_beta END,
            worth_success = CASE WHEN id = ${input.survivorId} THEN ${expectedMergedWorth.success}::numeric ELSE worth_success END,
            worth_failure = CASE WHEN id = ${input.survivorId} THEN ${expectedMergedWorth.failure}::numeric ELSE worth_failure END,
            updated_at = transaction_timestamp()
        WHERE workspace_id = ${input.workspaceId}
          AND id IN (${idList(ids)})
          AND status = 'active'
          AND valid_to IS NULL
          AND NOT (COALESCE(metadata, '{}'::jsonb) ? ${PENDING_KEY})
        RETURNING id
      `)
      );
      if (updated.length !== ids.length)
        throw new Error("consolidation apply compare-and-set failed");
      return snapshot;
    }).catch((error: unknown) => {
      if (error instanceof Error && error.message === "consolidation apply compare-and-set failed")
        return null;
      throw error;
    });
  }

  private async compensate(
    tx: ConsolidationTx,
    snapshot: ConsolidationMergeSnapshot,
    review: ReplayFailureReview,
    rows: FactRow[]
  ): Promise<boolean> {
    if (!pendingRows(snapshot, rows)) return false;
    const ids = participantIds(snapshot);
    const changed = rowsOf<{ id: string }>(
      await tx.execute(sql`
      UPDATE mnemosyne.mnemo_fact
      SET metadata = metadata - '${sql.raw(PENDING_KEY)}',
          status = 'active',
          valid_to = NULL,
          merged_into_id = NULL,
          worth_alpha = CASE WHEN id = ${snapshot.survivorId} THEN ${snapshot.previousWorth.alpha}::numeric ELSE worth_alpha END,
          worth_beta = CASE WHEN id = ${snapshot.survivorId} THEN ${snapshot.previousWorth.beta}::numeric ELSE worth_beta END,
          worth_success = CASE WHEN id = ${snapshot.survivorId} THEN ${snapshot.previousWorth.success}::numeric ELSE worth_success END,
          worth_failure = CASE WHEN id = ${snapshot.survivorId} THEN ${snapshot.previousWorth.failure}::numeric ELSE worth_failure END,
          updated_at = transaction_timestamp()
      WHERE workspace_id = ${snapshot.workspaceId}
        AND id IN (${idList(ids)})
        AND metadata #>> '{${sql.raw(PENDING_KEY)},operationId}' = ${snapshot.operationId}
        AND ((id = ${snapshot.survivorId} AND status = 'active' AND valid_to IS NULL
              AND worth_alpha = ${snapshot.expectedMergedWorth.alpha}::numeric
              AND worth_beta = ${snapshot.expectedMergedWorth.beta}::numeric
              AND worth_success = ${snapshot.expectedMergedWorth.success}::numeric
              AND worth_failure = ${snapshot.expectedMergedWorth.failure}::numeric)
             OR (id <> ${snapshot.survivorId} AND status = 'merged' AND valid_to IS NOT NULL
                 AND merged_into_id = ${snapshot.survivorId}))
      RETURNING id
    `)
    );
    if (changed.length !== ids.length)
      throw new Error("consolidation compensation compare-and-set failed");
    await tx.execute(sql`
      INSERT INTO mnemosyne.mnemo_review_queue (id, workspace_id, fact_id, reason)
      VALUES (${`mrev_${randomUUID()}`}, ${snapshot.workspaceId}, ${snapshot.survivorId}, 'manual')
    `);
    void review;
    return true;
  }

  async rollbackConsolidationMerge(input: {
    snapshot: ConsolidationMergeSnapshot;
    review: ReplayFailureReview;
  }): Promise<"rolled_back" | "conflict"> {
    return this.withWorkspace(input.snapshot.workspaceId, async (tx) => {
      const rows = await this.lockRows(tx, input.snapshot);
      return (await this.compensate(tx, input.snapshot, input.review, rows))
        ? "rolled_back"
        : "conflict";
    }).catch((error: unknown) => {
      if (
        error instanceof Error &&
        error.message === "consolidation compensation compare-and-set failed"
      )
        return "conflict" as const;
      throw error;
    });
  }

  async finalizeConsolidationMerge(input: {
    snapshot: ConsolidationMergeSnapshot;
    applyReplayBoost: boolean;
  }): Promise<"finalized" | "conflict"> {
    return this.withWorkspace(input.snapshot.workspaceId, async (tx) => {
      const rows = await this.lockRows(tx, input.snapshot);
      if (!pendingRows(input.snapshot, rows)) return "conflict";
      const ids = participantIds(input.snapshot);
      const boost = input.applyReplayBoost ? 1 : 0;
      const changed = rowsOf<{ id: string }>(
        await tx.execute(sql`
        UPDATE mnemosyne.mnemo_fact
        SET metadata = metadata - '${sql.raw(PENDING_KEY)}',
            worth_alpha = CASE WHEN id = ${input.snapshot.survivorId} THEN ${input.snapshot.expectedMergedWorth.alpha + boost}::numeric ELSE worth_alpha END,
            worth_beta = CASE WHEN id = ${input.snapshot.survivorId} THEN ${input.snapshot.expectedMergedWorth.beta}::numeric ELSE worth_beta END,
            worth_success = CASE WHEN id = ${input.snapshot.survivorId} THEN ${input.snapshot.expectedMergedWorth.success + boost}::numeric ELSE worth_success END,
            worth_failure = CASE WHEN id = ${input.snapshot.survivorId} THEN ${input.snapshot.expectedMergedWorth.failure}::numeric ELSE worth_failure END,
            updated_at = transaction_timestamp()
        WHERE workspace_id = ${input.snapshot.workspaceId}
          AND id IN (${idList(ids)})
          AND metadata #>> '{${sql.raw(PENDING_KEY)},operationId}' = ${input.snapshot.operationId}
          AND ((id = ${input.snapshot.survivorId} AND status = 'active' AND valid_to IS NULL
                AND worth_alpha = ${input.snapshot.expectedMergedWorth.alpha}::numeric
                AND worth_beta = ${input.snapshot.expectedMergedWorth.beta}::numeric
                AND worth_success = ${input.snapshot.expectedMergedWorth.success}::numeric
                AND worth_failure = ${input.snapshot.expectedMergedWorth.failure}::numeric)
               OR (id <> ${input.snapshot.survivorId} AND status = 'merged' AND valid_to IS NOT NULL
                   AND merged_into_id = ${input.snapshot.survivorId}))
        RETURNING id
      `)
      );
      if (changed.length !== ids.length)
        throw new Error("consolidation finalize compare-and-set failed");
      return "finalized";
    }).catch((error: unknown) => {
      if (
        error instanceof Error &&
        error.message === "consolidation finalize compare-and-set failed"
      )
        return "conflict" as const;
      throw error;
    });
  }

  async refreshConsolidationMergeLease(input: {
    snapshot: ConsolidationMergeSnapshot;
    leaseExpiresAt: Date;
  }): Promise<"refreshed" | "conflict"> {
    return this.withWorkspace(input.snapshot.workspaceId, async (tx) => {
      const rows = await this.lockRows(tx, input.snapshot);
      if (!pendingRows(input.snapshot, rows)) return "conflict";
      const ids = participantIds(input.snapshot);
      const changed = rowsOf<{ id: string }>(
        await tx.execute(sql`
        UPDATE mnemosyne.mnemo_fact
        SET metadata = jsonb_set(metadata, '{${sql.raw(PENDING_KEY)},leaseExpiresAt}', to_jsonb(${input.leaseExpiresAt.toISOString()}::text), false),
            updated_at = transaction_timestamp()
        WHERE workspace_id = ${input.snapshot.workspaceId}
          AND id IN (${idList(ids)})
          AND metadata #>> '{${sql.raw(PENDING_KEY)},operationId}' = ${input.snapshot.operationId}
        RETURNING id
      `)
      );
      if (changed.length !== ids.length)
        throw new Error("consolidation refresh compare-and-set failed");
      return "refreshed";
    }).catch((error: unknown) => {
      if (
        error instanceof Error &&
        error.message === "consolidation refresh compare-and-set failed"
      )
        return "conflict" as const;
      throw error;
    });
  }

  async inspectConsolidationMergeState(
    snapshot: ConsolidationMergeSnapshot
  ): Promise<"pending" | "restored" | "retained" | "divergent"> {
    return this.withWorkspace(snapshot.workspaceId, async (tx) => {
      const rows = await this.lockRows(tx, snapshot);
      if (pendingRows(snapshot, rows)) return "pending";
      if (rows.length !== participantIds(snapshot).length) return "divergent";
      const survivor = rows.find((row) => row.id === snapshot.survivorId);
      const absorbed = rows.filter((row) => row.id !== snapshot.survivorId);
      const noMarkers = rows.every((row) => markerOf(row) === undefined);
      if (
        survivor &&
        noMarkers &&
        survivor.status === "active" &&
        survivor.valid_to == null &&
        worthEquals(survivor, snapshot.previousWorth) &&
        absorbed.every((row) => row.status === "active" && row.valid_to == null)
      )
        return "restored";
      const boosted = {
        ...snapshot.expectedMergedWorth,
        alpha: snapshot.expectedMergedWorth.alpha + 1,
        success: snapshot.expectedMergedWorth.success + 1,
      };
      if (
        survivor &&
        noMarkers &&
        survivor.status === "active" &&
        survivor.valid_to == null &&
        (worthEquals(survivor, snapshot.expectedMergedWorth) || worthEquals(survivor, boosted)) &&
        absorbed.every(
          (row) =>
            row.status === "merged" &&
            row.valid_to != null &&
            row.merged_into_id === snapshot.survivorId
        )
      )
        return "retained";
      return "divergent";
    });
  }

  async recoverExpiredConsolidationMerges(input: {
    workspaceId: string;
    expiredBefore: Date;
  }): Promise<number> {
    const discovered = await this.withWorkspace(input.workspaceId, async (tx) =>
      rowsOf<{ marker: ConsolidationMarker }>(
        await tx.execute(sql`
      SELECT DISTINCT metadata->'${sql.raw(PENDING_KEY)}' AS marker
      FROM mnemosyne.mnemo_fact
      WHERE workspace_id = ${input.workspaceId}
        AND metadata ? ${PENDING_KEY}
        AND metadata #>> '{${sql.raw(PENDING_KEY)},survivorId}' = id
        AND (metadata #>> '{${sql.raw(PENDING_KEY)},leaseExpiresAt}')::timestamptz <= ${input.expiredBefore.toISOString()}::timestamptz
    `)
      )
    );
    let recovered = 0;
    for (const { marker } of discovered) {
      if (!marker || marker.workspaceId !== input.workspaceId) continue;
      const restored = await this.withWorkspace(input.workspaceId, async (tx) => {
        const rows = await this.lockRows(tx, marker);
        if (
          !pendingRows(marker, rows) ||
          !rows.every((row) => {
            const refreshed = markerOf(row);
            return (
              refreshed?.operationId === marker.operationId &&
              new Date(refreshed.leaseExpiresAt).getTime() <= input.expiredBefore.getTime()
            );
          })
        )
          return false;
        return this.compensate(
          tx,
          marker,
          {
            reason: "replay_execution_failed",
            passCount: 0,
            failCount: 0,
            queriesUsed: [],
          },
          rows
        );
      }).catch((error: unknown) => {
        if (
          error instanceof Error &&
          error.message === "consolidation compensation compare-and-set failed"
        )
          return false;
        throw error;
      });
      if (restored) recovered += 1;
    }
    return recovered;
  }
}
