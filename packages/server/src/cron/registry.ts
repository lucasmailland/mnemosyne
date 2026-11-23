import type { Telemetry } from "@mnemo-ai/types";
import { type CronSchedule, msUntilNext } from "./schedule.js";

export interface CronJob {
  key: string;
  schedule: CronSchedule;
  handler: () => Promise<void>;
}

interface RegistryLogger {
  info(o: object, m?: string): void;
  warn(o: object, m?: string): void;
}
export interface CronRegistryHandle {
  stop(): void;
}

/**
 * Cluster-wide mutual exclusion for one cron run. `runExclusive` runs `fn` only
 * when this replica takes the job's lock and resolves `false` when another
 * replica holds it. The lock stays held for at least `holdMs` from the start so
 * a replica whose timer fires a little later (clock skew) still finds it taken.
 */
export interface CronLock {
  runExclusive(jobKey: string, holdMs: number, fn: () => Promise<void>): Promise<boolean>;
}

/**
 * Jobs that work on this process's own memory, so every replica runs its own:
 * `mnemo.meter.persist` drains the in-process meter queue each replica fills.
 * Every other job works on the shared database or the shared Redis, and with a
 * lock configured exactly one replica takes each run.
 */
const PER_REPLICA_JOBS = new Set(["mnemo.meter.persist"]);

export function cronScope(jobKey: string): "replica" | "cluster" {
  return PER_REPLICA_JOBS.has(jobKey) ? "replica" : "cluster";
}

// ponytail: covers clock skew between replicas up to 10 s (NTP keeps it in ms).
// Beyond that a late replica can run the same tick again; a per-tick run table
// would close it.
const SKEW_GUARD_MS = 10_000;

export function lockHoldMs(schedule: CronSchedule): number {
  return schedule.kind === "interval"
    ? Math.min(Math.floor(schedule.ms / 2), SKEW_GUARD_MS)
    : SKEW_GUARD_MS;
}

export function startCronRegistry(
  jobs: CronJob[],
  deps: {
    logger: RegistryLogger;
    telemetry: Telemetry;
    disabled?: Set<string>;
    shedGate?: { isShed(jobKey: string): boolean };
    /** Absent (no database, tests): every replica runs every job, as before. */
    lock?: CronLock;
  }
): CronRegistryHandle {
  const timers: Array<ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>> = [];
  let stopped = false;
  const exclusive = (job: CronJob) => deps.lock !== undefined && cronScope(job.key) === "cluster";

  const runOnce = async (job: CronJob) => {
    if (deps.shedGate?.isShed(job.key)) {
      deps.logger.info({ cron: job.key }, "cron.shed_skipped");
      return;
    }
    const start = Date.now();
    let ran = true;
    try {
      if (exclusive(job)) {
        ran = await deps.lock!.runExclusive(job.key, lockHoldMs(job.schedule), job.handler);
      } else {
        await job.handler();
      }
      if (ran) {
        deps.telemetry.counter("mnemo_cron_runs_total", 1, { job: job.key, status: "ok" });
        deps.logger.info({ cron: job.key, ms: Date.now() - start }, "cron.tick_ok");
      } else {
        deps.logger.info({ cron: job.key }, "cron.lock_skipped");
      }
    } catch (err) {
      deps.telemetry.counter("mnemo_cron_runs_total", 1, { job: job.key, status: "error" });
      deps.logger.warn({ cron: job.key, err }, "cron.tick_error");
    } finally {
      if (ran)
        deps.telemetry.histogram("mnemo_cron_duration_ms", Date.now() - start, { job: job.key });
    }
  };

  for (const job of jobs) {
    // `mnemo.plugin.sync` also disables every per-plugin `mnemo.plugin.sync:<id>`.
    if (deps.disabled?.has(job.key) || deps.disabled?.has(job.key.split(":")[0]!)) {
      deps.logger.info({ cron: job.key }, "cron.disabled");
      continue;
    }
    const schedule = job.schedule;
    if (schedule.kind === "interval" && !exclusive(job)) {
      const t = setInterval(() => void runOnce(job), schedule.ms);
      (t as { unref?: () => void }).unref?.();
      timers.push(t);
    } else {
      // Exclusive interval jobs fire on wall-clock multiples of their period, so
      // every replica reaches the same tick together and the lock decides it.
      const delay = () =>
        schedule.kind === "interval"
          ? schedule.ms - (Date.now() % schedule.ms)
          : msUntilNext(schedule);
      const arm = () => {
        if (stopped) return;
        const t = setTimeout(() => {
          void runOnce(job).finally(arm);
        }, delay());
        (t as { unref?: () => void }).unref?.();
        timers.push(t);
      };
      arm();
    }
    deps.logger.info({ cron: job.key, schedule: job.schedule }, "cron.registered");
  }

  return {
    stop() {
      stopped = true;
      for (const t of timers) {
        clearTimeout(t as ReturnType<typeof setTimeout>);
        clearInterval(t as ReturnType<typeof setInterval>);
      }
    },
  };
}
