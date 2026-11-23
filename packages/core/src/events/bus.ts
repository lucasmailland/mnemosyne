/**
 * Pure in-process typed event bus — no I/O, no external deps.
 *
 * Design:
 *  - Map<pattern, Set<listener>> — O(patterns) emit, O(1) subscribe/unsubscribe.
 *  - channelMatches() supports:
 *      exact        "fact.created"  ↔  "fact.created"
 *      domain alias "facts.*"       ↔  "fact.*" prefix
 *      trailing     "session.*"     ↔  "session." prefix
 *      match-all    "*"             ↔  any channel (WS uses this)
 *  - Listeners are isolated: a throw in one never breaks others.
 *  - Hexagonal-purity: no drizzle, no postgres, no redis, no hono imports here.
 */

import type { MnemoBusEvent } from "@mnemo-ai/types";

export type EventListener = (event: MnemoBusEvent) => void;

export interface EventBus {
  /** Subscribe to events matching `pattern`. Returns an unsubscribe fn. */
  subscribe(pattern: string, listener: EventListener): () => void;
  /** Emit an event to all matching subscribers. */
  emit(event: MnemoBusEvent): void;
  /** Number of distinct patterns that have at least one listener. */
  patternCount(): number;
}

/**
 * Domain-alias table: maps the public channel-pattern aliases used by
 * WsSubscription.subscribe.channel to the internal channel prefix used
 * by the event bus emit().
 */
const DOMAIN_ALIAS: Record<string, string> = {
  "facts.*": "fact.",
  "tasks.*": "task.",
  "events.*": "event.",
};

/**
 * Returns true if a subscriber's `pattern` matches a given event `channel`.
 *
 * Match rules (in order):
 *  1. "*"           — match anything (WS handler subscribes with this)
 *  2. DOMAIN_ALIAS  — "facts.*" → any channel starting with "fact."
 *  3. Trailing ".*" — "session.*" → any channel starting with "session."
 *  4. Exact         — "fact.created" → "fact.created" only
 */
export function channelMatches(pattern: string, channel: string): boolean {
  if (pattern === "*") return true;

  const aliased = DOMAIN_ALIAS[pattern];
  if (aliased) return channel.startsWith(aliased);

  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -1); // "session." (strip the trailing "*")
    return channel.startsWith(prefix);
  }

  return pattern === channel;
}

export function createEventBus(): EventBus {
  const subscribers = new Map<string, Set<EventListener>>();

  return {
    subscribe(pattern, listener) {
      let set = subscribers.get(pattern);
      if (!set) {
        set = new Set();
        subscribers.set(pattern, set);
      }
      set.add(listener);

      return () => {
        const s = subscribers.get(pattern);
        if (!s) return;
        s.delete(listener);
        if (s.size === 0) subscribers.delete(pattern);
      };
    },

    emit(event) {
      for (const [pattern, set] of subscribers) {
        if (!channelMatches(pattern, event.channel)) continue;
        for (const listener of set) {
          try {
            listener(event);
          } catch {
            // Isolated: a throwing subscriber must not break others.
          }
        }
      }
    },

    patternCount() {
      return subscribers.size;
    },
  };
}
