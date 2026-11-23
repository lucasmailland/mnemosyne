/**
 * §34.8 shedding gate (MEMORY_IMPROVEMENT.md:3694). Wraps the injected QueueAdapter.
 */
import type { QueueAdapter, EnqueueOpts } from "@mnemo-ai/types";
import { priorityOf, decideShed, isPaused, type ShedState } from "@mnemo-ai/core";
import { pgPoolUtilization, queueShedTotal } from "../metrics/backpressure.js";

export interface SheddingOpts { poolUtil: () => number; }
/**
 * APP-010: a shed job is refused, not acknowledged. The outbox worker (the only
 * producer) marks its entry done when enqueue() resolves, so a resolved "shed"
 * used to drop the work while the outbox said it was processed.
 */
export class QueueShedError extends Error {
  readonly retryable = true;
  constructor(jobName: string, stage: number) {
    super(`queue shed job "${jobName}" at load stage ${stage}; retry later`);
    this.name = "QueueShedError";
  }
}

export function createSheddingQueue(inner: QueueAdapter, opts: SheddingOpts): QueueAdapter {
  let state: ShedState = { stage: 0, paused: new Set() };

  function refresh(): ShedState {
    const util = Math.max(0, Math.min(1, opts.poolUtil()));
    pgPoolUtilization.set({}, util);
    state = decideShed(util, state);
    return state;
  }

  return {
    id: `shedding(${inner.id})`,
    async enqueue(jobName: string, data: unknown, enqueueOpts?: EnqueueOpts): Promise<string> {
      const prio = priorityOf(jobName);
      const s = refresh();
      if (isPaused(s, prio)) {
        queueShedTotal.inc({ stage: `stage${s.stage}` });
        throw new QueueShedError(jobName, s.stage);
      }
      return inner.enqueue(jobName, data, { ...enqueueOpts, priority: prio });
    },
    async schedule(jobName, cron, data) {
      return inner.schedule(jobName, cron, data);
    },
    process: inner.process.bind(inner),
    healthCheck: inner.healthCheck.bind(inner),
    close: inner.close.bind(inner),
  };
}
