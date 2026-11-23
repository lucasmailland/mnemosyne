/**
 * SloRollbackMonitor — AB4 canary auto-rollback.
 * spec §35 lines 4467 + 2094–2099.
 *
 * Polls a metrics source, applies evaluateCanary, and calls onRollback
 * when the canary should be rolled back. Uses dependency injection
 * so it's testable without a real metrics backend.
 *
 * Wave V's Prometheus metrics (requestsTotal, recallLatency) are the
 * production source. This monitor consumes the error-ratio series
 * computed externally — it does NOT redefine SLOs.
 */
import type { MetricsSnapshot, CanaryConfig } from "@mnemo-ai/core/cognitive";
import { evaluateCanary, DEFAULT_CANARY_CONFIG } from "@mnemo-ai/core/cognitive";
import { logger } from "../logging.js";

export interface SloRollbackMonitorOptions {
  /** Returns the current baseline + canary metrics snapshot, or null if unavailable. */
  getMetrics: () => Promise<{ baseline: MetricsSnapshot | null; canary: MetricsSnapshot | null }>;
  /** Called when evaluateCanary returns 'rollback'. Called at most once per monitor run. */
  onRollback: (reason: string) => void | Promise<void>;
  /** Polling interval in milliseconds. Default 60s. */
  pollIntervalMs?: number;
  canaryConfig?: CanaryConfig;
  /** Log label for cron. */
  label?: string;
}

export class SloRollbackMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly config: CanaryConfig;
  private readonly pollIntervalMs: number;
  private readonly label: string;
  private rolledBack = false;

  constructor(private readonly opts: SloRollbackMonitorOptions) {
    this.config = opts.canaryConfig ?? DEFAULT_CANARY_CONFIG;
    this.pollIntervalMs = opts.pollIntervalMs ?? 60_000;
    this.label = opts.label ?? "mnemo.canary.monitor";
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.poll();
    }, this.pollIntervalMs);
    this.timer.unref?.();
    logger.info({ label: this.label }, "cron: started");
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async poll(): Promise<void> {
    if (this.rolledBack) return; // Only roll back once per monitor lifetime.
    try {
      const { baseline, canary } = await this.opts.getMetrics();
      const decision = evaluateCanary(baseline, canary, this.config);
      logger.debug({ label: this.label, decision, baseline, canary }, "cron: mnemo.canary.monitor");

      if (decision === "rollback") {
        this.rolledBack = true;
        const reason = `Canary rollback: error_rate_delta=${
          canary && baseline ? ((canary.errorRate - baseline.errorRate) * 100).toFixed(2) : "?"
        }%, p99_delta=${
          canary && baseline ? (canary.p99 - baseline.p99).toFixed(0) : "?"
        }ms`;
        logger.warn({ label: this.label, reason }, "cron: mnemo.canary.rollback");
        await this.opts.onRollback(reason);
      }
    } catch (err) {
      logger.warn({ err, label: this.label }, "cron: mnemo.canary.monitor.error");
    }
  }
}
