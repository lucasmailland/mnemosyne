/**
 * Typed event envelope for the Mnemosyne internal event bus (spec §4).
 *
 * The bus is a pure in-process pub/sub: no network, no persistence, no
 * at-least-once guarantees. Its primary consumers are the WebSocket
 * subscription handler (§4 /memory/ws) and monitoring.
 */

export type MnemoEventType =
  | "fact.created"
  | "fact.updated"
  | "fact.archived"
  | "task.created"
  | "task.transitioned"
  | "task.completed"
  | "event.recorded"
  | "recall.hit"
  | "session.collapsed"
  | "health.alert"
  | "federation.conflict"
  | "reminder.triggered";

export interface MnemoBusEvent<P = unknown> {
  id?: string; // §35 monotonic replay id (optional for backward compat)
  channel: string;
  type: MnemoEventType;
  payload: P;
  timestamp: string; // ISO-8601 UTC
  traceId: string;
}

export type MnemoChannelPattern =
  | "facts.*"
  | "facts.created"
  | "tasks.*"
  | "events.*"
  | `session.${string}`
  | `agent.${string}.recall`
  | "health"
  | "federation.sync";

export interface MnemoEventFilter {
  entityId?: string;
  agentId?: string;
  memoryType?: string;
}

export interface WsSubscription {
  subscribe?: { channel: string; filter?: MnemoEventFilter };
  unsubscribe?: { channel: string };
  /** §35 reconnection: replay events since lastEventId on these channels */
  resubscribe?: { channels: string[]; lastEventId: string };
}
