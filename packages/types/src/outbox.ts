// Transactional outbox types — DATA_MODEL.md §2.12
// All non-PG side effects are routed through this table for at-least-once delivery.

export type OutboxEventType =
  | "vector_upsert"
  | "vector_delete"
  | "cache_bust"
  | "cache_set"
  | "queue_job"
  | "webhook_fire"
  | "hyperedge_bump"
  | "lsh_upsert";

export interface OutboxEntry {
  id: string;
  workspaceId: string;
  eventType: OutboxEventType;
  payload: Record<string, unknown>;
  createdAt: Date;
  claimedAt?: Date;
  processedAt?: Date;
  attempts: number;
  lastError?: string;
}

export interface WebhookFirePayload {
  webhookId: string;
  workspaceId: string;
  url: string;
  eventType: string;
  payload: Record<string, unknown>;
  /**
   * Not written any more (APP-030): the worker decrypts the secret from the
   * endpoint row. Kept optional so entries queued before the change still parse.
   */
  secret?: string;
}
