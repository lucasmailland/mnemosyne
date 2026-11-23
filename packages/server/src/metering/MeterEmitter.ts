/**
 * MeterEmitter — fire-and-forget meter event ingestion.
 * spec §35 lines 4215–4217: async, never on the request critical path, zero rate-limit impact.
 *
 * Inserts raw events into the in-memory queue for batch aggregation.
 * Failures are logged but never thrown.
 */
import { randomUUID } from "node:crypto";
import type { MeterMetric, MeterEvent } from "@mnemo-ai/core/cognitive";
import { logger } from "../logging.js";

export interface MeterStore {
  /** Append a raw meter event. Should never throw to callers. */
  appendEvent(event: MeterEvent): Promise<void> | void;
}

/**
 * In-memory meter queue — events accumulate here until the 5-min aggregation cron drains them.
 * For production this could be replaced with a DB insert into mnemo_meter_event,
 * but for the test-first approach we use an in-memory queue that the aggregate fn can drain.
 */
export class InMemoryMeterStore implements MeterStore {
  private queue: MeterEvent[] = [];

  appendEvent(event: MeterEvent): void {
    this.queue.push(event);
  }

  drain(): MeterEvent[] {
    const events = this.queue.splice(0);
    return events;
  }

  peek(): MeterEvent[] {
    return this.queue.slice();
  }
}

/** Global in-memory store (used in server boot). */
export const globalMeterStore = new InMemoryMeterStore();

/**
 * Emit a meter event for a workspace.
 * Fire-and-forget: errors are logged but never thrown.
 * spec §35 lines 4215–4217.
 */
export function emitMeter(
  workspaceId: string,
  metric: MeterMetric,
  quantity = 1,
  store: MeterStore = globalMeterStore,
): void {
  try {
    const event: MeterEvent = {
      workspaceId,
      metric,
      quantity,
      occurredAt: new Date(),
      idempotencyKey: randomUUID(),
    };
    const result = store.appendEvent(event);
    if (result instanceof Promise) {
      result.catch((err: unknown) => {
        logger.warn({ err, metric, workspaceId }, "meter.emit.error");
      });
    }
  } catch (err) {
    // Never throw — spec line 4215
    logger.warn({ err, metric, workspaceId }, "meter.emit.sync.error");
  }
}
