/**
 * In-process queue adapter — executes jobs immediately (synchronously in the
 * next microtask tick). Suitable for single-process dev/test.
 * For production durability, swap with PgBossQueueAdapter.
 */
import { randomUUID } from "node:crypto";
import type { QueueAdapter, EnqueueOpts, JobHandler, HealthStatus } from "@mnemo-ai/types";
import { logger } from "./logging.js";

export class InMemoryQueueAdapter implements QueueAdapter {
  readonly id = "in-memory-queue";
  private handlers = new Map<string, JobHandler<unknown>>();

  async enqueue(jobName: string, data: unknown, _opts?: EnqueueOpts): Promise<string> {
    const id = randomUUID();
    const handler = this.handlers.get(jobName);
    if (!handler) {
      // P74 made this loud; APP-010 makes it a refusal. The outbox worker, the
      // only producer, then keeps its entry and retries it, and an entry that
      // never finds a consumer is dead-lettered where an operator sees it.
      logger.warn(
        { operation: "queue.enqueue", jobName, jobId: id },
        `in-memory queue has no handler for job "${jobName}". ` +
          `Register one with queue.process("${jobName}", handler) before the ` +
          `producer runs, or remove the producer.`
      );
      throw new Error(`no handler registered for queue job "${jobName}"`);
    }
    // APP-010: run the job before answering, so the caller learns whether it
    // succeeded. A handler that throws rejects enqueue().
    try {
      await handler(data);
    } catch (err: unknown) {
      logger.error({ operation: "queue.handler", jobName, jobId: id, err }, "queue handler threw");
      throw err;
    }
    return id;
  }

  async schedule(_jobName: string, _cron: string, _data?: unknown): Promise<void> {
    // No-op: in-memory queue does not support recurring schedules.
    // Replace with pg-boss for production cron scheduling.
  }

  async process<T = unknown>(jobName: string, handler: JobHandler<T>): Promise<void> {
    this.handlers.set(jobName, handler as JobHandler<unknown>);
  }

  async healthCheck(): Promise<HealthStatus> {
    return { status: "ok", latencyMs: 0 };
  }

  async close(): Promise<void> {
    this.handlers.clear();
  }
}
