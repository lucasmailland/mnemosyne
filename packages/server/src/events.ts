/**
 * Thin helper to emit a typed bus event from route handlers.
 *
 * Design decisions:
 *  - bus is optional: when absent all calls are no-ops (backward compat, tests).
 *  - channel defaults to the event type string so callers don't need to pass
 *    a redundant channel when the channel and type are identical.
 *  - Errors from the bus itself are swallowed to keep route handlers clean.
 *  - §35 id stamping: events get monotonic IDs for WS replay.
 */

import type { EventBus } from "@mnemo-ai/core";
import { EventIdGenerator } from "@mnemo-ai/core";
import type { MnemoBusEvent, MnemoEventType } from "@mnemo-ai/types";
import type { ReplayBuffer } from "./resilience/replayBuffer.js";

const eventIds = new EventIdGenerator();

export function emitEvent(
  bus: EventBus | undefined,
  type: MnemoEventType,
  payload: unknown,
  traceId: string,
  channel?: string,
  replay?: ReplayBuffer,
): void {
  if (!bus) return;
  try {
    const workspaceId = (payload as Record<string, unknown> | null)?.["workspaceId"] as string | undefined ?? "global";
    const event: MnemoBusEvent = {
      id: eventIds.next(workspaceId),
      channel: channel ?? type,
      type,
      payload,
      timestamp: new Date().toISOString(),
      traceId,
    };
    bus.emit(event);
    if (replay) {
      void replay.record(workspaceId, event as MnemoBusEvent & { id: string }).catch(() => {});
    }
  } catch {
    // Best-effort — a broken bus must never break HTTP handlers.
  }
}
