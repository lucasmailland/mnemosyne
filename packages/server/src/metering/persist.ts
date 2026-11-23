/**
 * Durable meter persistence — F15, spec §35 lines 4203-4217.
 *
 * Drains the in-memory meter queue and write-throughs each event to the durable
 * mnemo_meter_event table via the StorageAdapter port. Cost is computed with the
 * pure core `meterEventCostUsd`. Fully fire-and-forget: a storage failure is
 * logged and the batch is dropped (never throws onto a request or cron path) —
 * matching the spec's "never on the request critical path" contract (line 4217).
 *
 * Hexagonal: server orchestrates; table access is through the port only.
 */
import { meterEventCostUsd } from "@mnemo-ai/core/cognitive";
import type { MeterEvent } from "@mnemo-ai/core/cognitive";
import { randomUUID } from "node:crypto";
import { logger } from "../logging.js";
import type { InMemoryMeterStore } from "./MeterEmitter.js";

/** Minimal port surface this module needs. */
export interface MeterPersistStorage {
  appendMeterEvent?(event: {
    workspaceId: string;
    metric: string;
    quantity: number;
    occurredAt: Date;
    costUsd: number;
    idempotencyKey: string;
  }): Promise<void>;
}

/**
 * Drain the in-memory queue and persist each event durably.
 * Returns the number of events that were successfully persisted.
 */
export async function persistDrainedMeterEvents(
  store: InMemoryMeterStore,
  storage: MeterPersistStorage,
): Promise<number> {
  if (!storage.appendMeterEvent) return 0;
  const batch: MeterEvent[] = store.drain();
  if (batch.length === 0) return 0;

  let persisted = 0;
  for (const ev of batch) {
    try {
      await storage.appendMeterEvent({
        workspaceId: ev.workspaceId,
        metric: ev.metric,
        quantity: ev.quantity,
        occurredAt: ev.occurredAt,
        costUsd: meterEventCostUsd(ev),
        idempotencyKey: ev.idempotencyKey ?? randomUUID(),
      });
      persisted += 1;
    } catch (err) {
      // Never throw onto the cron/request path (spec line 4217). The event is
      // dropped from the durable store for this tick; the in-memory accumulator
      // already counted it for the warm usage path, so usage is not lost — only
      // the durable spend row is. Logged for observability.
      logger.warn({ err, metric: ev.metric, workspaceId: ev.workspaceId }, "meter.persist.error");
    }
  }
  return persisted;
}
