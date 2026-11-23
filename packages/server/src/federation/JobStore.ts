// Federation sync jobs (POST /memory/federation/sync, GET /sync/:jobId).
// The server keeps them in Postgres (DrizzleSyncJobStore, migration 0063) and
// falls back to InMemoryJobStore, which forgets them on restart, only when the
// Postgres adapter is not installed.

export type SyncJobStatus = "pending" | "running" | "done" | "failed";

export interface SyncJob {
  id: string;
  peerId: string;
  workspaceId: string;
  status: SyncJobStatus;
  startedAt: string; // ISO string (avoid Date to keep serializable)
  completedAt?: string;
  outcome?: Record<string, unknown>;
  error?: string;
}

export type SyncJobPatch = Partial<Pick<SyncJob, "status" | "completedAt" | "outcome" | "error">>;

/** How often the process running a job bumps it; DrizzleSyncJobStore fails it after 4 misses. */
export const SYNC_JOB_HEARTBEAT_MS = 30_000;

export interface SyncJobStore {
  create(job: SyncJob): Promise<void>;
  /** Only a job of workspaceId; another workspace's job is not found. */
  get(id: string, workspaceId: string): Promise<SyncJob | null>;
  /** A finished job (done or failed) is never changed again. */
  update(id: string, workspaceId: string, patch: SyncJobPatch): Promise<void>;
  heartbeat(id: string, workspaceId: string): Promise<void>;
  /**
   * Where the next sync from peerId into workspaceId resumes: `outcome.cursor`
   * of the latest finished job that recorded one, or null to start from the top.
   */
  lastCursor(peerId: string, workspaceId: string): Promise<string | null>;
}

export class InMemoryJobStore implements SyncJobStore {
  private readonly jobs = new Map<string, SyncJob>();

  async create(job: SyncJob): Promise<void> {
    this.jobs.set(job.id, job);
  }
  async get(id: string, workspaceId: string): Promise<SyncJob | null> {
    const job = this.jobs.get(id);
    return job && job.workspaceId === workspaceId ? job : null;
  }
  async update(id: string, workspaceId: string, patch: SyncJobPatch): Promise<void> {
    const job = await this.get(id, workspaceId);
    if (job && job.status !== "done" && job.status !== "failed") {
      this.jobs.set(id, { ...job, ...patch });
    }
  }
  async heartbeat(): Promise<void> {}
  async lastCursor(peerId: string, workspaceId: string): Promise<string | null> {
    let last: SyncJob | undefined;
    for (const job of this.jobs.values()) {
      if (job.peerId !== peerId || job.workspaceId !== workspaceId) continue;
      if (typeof job.outcome?.["cursor"] !== "string" || !job.completedAt) continue;
      if (!last || job.completedAt > last.completedAt!) last = job;
    }
    return (last?.outcome?.["cursor"] as string | undefined) ?? null;
  }
}
