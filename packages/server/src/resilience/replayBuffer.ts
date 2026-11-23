/**
 * §35 server-side event replay buffer (MEMORY_IMPROVEMENT.md:4681-4710).
 *
 * One buffer per workspace holds every event, in emit order. Catch-up finds
 * `lastEventId` there and keeps the later events whose channel matches any of
 * the requested patterns (`channelMatches`: exact, `tasks.*`, `*`, domain
 * aliases). Event ids are monotonic per workspace, so the client's last id is
 * in this buffer whatever channel it came from; a gap means it has been
 * evicted (size cap or TTL). The cap is per workspace, not per channel.
 */
import type { CacheAdapter, MnemoBusEvent } from "@mnemo-ai/types";
import { channelMatches, wsBufferKey } from "@mnemo-ai/core";

export type StampedEvent = MnemoBusEvent & { id: string };
export interface ReplayConfig {
  maxEvents: number;
  ttlSeconds: number;
}
export type CatchUpResult =
  | { type: "replay"; events: StampedEvent[]; gapDetected: false }
  | { type: "gap"; oldestAvailable: string | null; message: string };

const GAP_MSG = "Events between your lastEventId and this point are lost. Use REST API to sync.";

export interface ReplayBuffer {
  record(workspaceId: string, event: StampedEvent): Promise<void>;
  /** Events after `lastEventId` on any of `channels`, oldest first, each once. */
  catchUp(
    workspaceId: string,
    channels: string | readonly string[],
    lastEventId: string
  ): Promise<CatchUpResult>;
}

export function createReplayBuffer(cache: CacheAdapter, config: ReplayConfig): ReplayBuffer {
  if (!cache.lpushCapped || !cache.lrange) {
    return {
      async record() {},
      async catchUp() {
        return { type: "gap", oldestAvailable: null, message: GAP_MSG };
      },
    };
  }
  const lpushCapped = cache.lpushCapped.bind(cache);
  const lrange = cache.lrange.bind(cache);

  return {
    async record(workspaceId, event) {
      await lpushCapped(
        wsBufferKey(workspaceId),
        JSON.stringify(event),
        config.maxEvents,
        config.ttlSeconds
      );
    },
    async catchUp(workspaceId, channels, lastEventId) {
      const patterns = typeof channels === "string" ? [channels] : channels;
      const raw = await lrange(wsBufferKey(workspaceId), 0, -1);
      const seen = new Set<string>();
      const events = raw
        .map((r) => JSON.parse(r) as StampedEvent)
        .reverse()
        .filter((event) => {
          if (seen.has(event.id)) return false;
          seen.add(event.id);
          return true;
        });
      const idx = events.findIndex((e) => e.id === lastEventId);
      if (idx === -1) {
        return {
          type: "gap",
          oldestAvailable: events.length ? events[0]!.id : null,
          message: GAP_MSG,
        };
      }
      return {
        type: "replay",
        events: events
          .slice(idx + 1)
          .filter((e) => patterns.some((p) => channelMatches(p, e.channel))),
        gapDetected: false,
      };
    },
  };
}
