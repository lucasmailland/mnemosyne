/**
 * DrizzleSyncJobStore — Postgres-backed store for the async jobs
 * POST /memory/federation/sync starts (packages/server/src/federation/JobStore.ts)
 * over mnemo_federation_sync_job (migration 0063). Replaces InMemoryJobStore,
 * which forgot every job on restart.
 *
 * Like DrizzlePeerStore, SyncJob is mirrored below instead of imported, and
 * every call runs in its own transaction that downgrades to app_user when the
 * connection may and sets the mnemosyne.workspace_id GUC the table's RLS checks.
 *
 * A job whose process died stays pending or running in the table. The process
 * running a job bumps heartbeat_at (heartbeat()); a read that finds a pending or
 * running job with no heartbeat for STALE_AFTER marks it failed, so a poller
 * gets an answer instead of waiting forever. A finished job (done or failed) is
 * never changed again.
 */

import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import * as schema from "./schema/index.js";
import type { DrizzleClient } from "./DrizzleStorageAdapter.js";

/** Mirrors SyncJob in packages/server/src/federation/JobStore.ts. */
interface SyncJob {
  id: string;
  peerId: string;
  workspaceId: string;
  status: "pending" | "running" | "done" | "failed";
  startedAt: string;
  completedAt?: string;
  outcome?: Record<string, unknown>;
  error?: string;
}

type JobRow = typeof schema.federationSyncJobTable.$inferSelect;
type Tx = Parameters<Parameters<DrizzleClient["transaction"]>[0]>[0];

const jobs = schema.federationSyncJobTable;
const OPEN = ["pending", "running"];
const FINISHED = ["done", "failed"];
/** Four missed heartbeats of the server's SYNC_JOB_HEARTBEAT_MS (30 s). */
const STALE_AFTER = sql`interval '2 minutes'`;
export const INTERRUPTED_SYNC_JOB_ERROR =
  "The server stopped before this sync finished; start the sync again";

function toJob(row: JobRow): SyncJob {
  return {
    id: row.id,
    peerId: row.peerId,
    workspaceId: row.workspaceId,
    status: row.status as SyncJob["status"],
    startedAt: row.startedAt.toISOString(),
    ...(row.completedAt ? { completedAt: row.completedAt.toISOString() } : {}),
    ...(row.outcome !== null ? { outcome: row.outcome as Record<string, unknown> } : {}),
    ...(row.error !== null ? { error: row.error } : {}),
  };
}

export class DrizzleSyncJobStore {
  constructor(private readonly db: DrizzleClient) {}

  private run<T>(workspaceId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      const member = (await tx.execute(
        sql`SELECT pg_has_role(current_user, 'app_user', 'member') AS m`
      )) as unknown as Array<{ m?: boolean }>;
      if (member[0]?.m) await tx.execute(sql`SET LOCAL ROLE app_user`);
      await tx.execute(sql`SELECT set_config('mnemosyne.workspace_id', ${workspaceId}, true)`);
      return fn(tx);
    });
  }

  async create(job: SyncJob): Promise<void> {
    await this.run(job.workspaceId, (tx) =>
      tx.insert(jobs).values({
        id: job.id,
        workspaceId: job.workspaceId,
        peerId: job.peerId,
        status: job.status,
        startedAt: new Date(job.startedAt),
        completedAt: job.completedAt ? new Date(job.completedAt) : null,
        outcome: job.outcome ?? null,
        error: job.error ?? null,
      })
    );
  }

  /** The job, if it belongs to workspaceId; an abandoned one reads as failed. */
  async get(id: string, workspaceId: string): Promise<SyncJob | null> {
    const rows = await this.run(workspaceId, async (tx) => {
      await tx
        .update(jobs)
        .set({ status: "failed", completedAt: sql`now()`, error: INTERRUPTED_SYNC_JOB_ERROR })
        .where(
          and(
            eq(jobs.id, id),
            inArray(jobs.status, OPEN),
            sql`${jobs.heartbeatAt} < now() - ${STALE_AFTER}`
          )
        );
      return tx.select().from(jobs).where(eq(jobs.id, id));
    });
    return rows[0] ? toJob(rows[0]) : null;
  }

  /** Applies the patch unless the job already finished; counts as a heartbeat. */
  async update(
    id: string,
    workspaceId: string,
    patch: Partial<Pick<SyncJob, "status" | "completedAt" | "outcome" | "error">>
  ): Promise<void> {
    await this.run(workspaceId, (tx) =>
      tx
        .update(jobs)
        .set({
          heartbeatAt: sql`now()`,
          ...(patch.status ? { status: patch.status } : {}),
          ...(patch.completedAt ? { completedAt: new Date(patch.completedAt) } : {}),
          ...(patch.outcome ? { outcome: patch.outcome } : {}),
          ...(patch.error !== undefined ? { error: patch.error } : {}),
        })
        .where(and(eq(jobs.id, id), notInArray(jobs.status, FINISHED)))
    );
  }

  async heartbeat(id: string, workspaceId: string): Promise<void> {
    await this.update(id, workspaceId, {});
  }

  /** `outcome.cursor` of the latest finished job from peerId that recorded one. */
  async lastCursor(peerId: string, workspaceId: string): Promise<string | null> {
    // Served by idx_mnemo_fed_sync_job_peer_completed (migration 0064).
    const rows = await this.run(workspaceId, (tx) =>
      tx
        .select({ cursor: sql<string>`${jobs.outcome}->>'cursor'` })
        .from(jobs)
        .where(
          and(
            eq(jobs.peerId, peerId),
            inArray(jobs.status, FINISHED),
            sql`${jobs.outcome}->>'cursor' IS NOT NULL`
          )
        )
        .orderBy(sql`${jobs.completedAt} DESC NULLS LAST`)
        .limit(1)
    );
    return rows[0]?.cursor ?? null;
  }
}
