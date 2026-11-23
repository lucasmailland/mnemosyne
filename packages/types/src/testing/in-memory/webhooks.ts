// in-memory/webhooks.ts — InMemoryStorageAdapter's Webhooks port methods.
// decompose-inmemory-storage-adapter Batch B8b (design.md Module Map row 30).
// Bodies moved verbatim from InMemoryStorageAdapter.ts — the only edit is
// `this.<field>` → `state.<field>` (design.md D7 move-only rule).

import type {
  CreateWebhookEndpointInput,
  MnemoWebhookEndpoint,
  UpdateWebhookEndpointInput,
  CreateWebhookDeliveryInput,
  MnemoWebhookDelivery,
} from "../../ports.js";
import type { InMemoryStorageState } from "./state.js";

export async function createWebhookEndpoint(
  state: InMemoryStorageState,
  input: CreateWebhookEndpointInput
): Promise<MnemoWebhookEndpoint> {
  const now = new Date();
  const endpoint: MnemoWebhookEndpoint = {
    id: input.id,
    workspaceId: input.workspaceId,
    url: input.url,
    events: input.events,
    secretHash: input.secretHash,
    isActive: true,
    description: input.description ?? null,
    failureCount: 0,
    disabledAt: null,
    createdAt: now,
    updatedAt: now,
  };
  state.webhookEndpoints.push(endpoint);
  return endpoint;
}

export async function getWebhookEndpoint(
  state: InMemoryStorageState,
  id: string,
  workspaceId: string
): Promise<MnemoWebhookEndpoint | null> {
  return state.webhookEndpoints.find((e) => e.id === id && e.workspaceId === workspaceId) ?? null;
}

export async function listWebhookEndpoints(
  state: InMemoryStorageState,
  workspaceId: string
): Promise<MnemoWebhookEndpoint[]> {
  return state.webhookEndpoints.filter((e) => e.workspaceId === workspaceId);
}

export async function updateWebhookEndpoint(
  state: InMemoryStorageState,
  id: string,
  workspaceId: string,
  input: UpdateWebhookEndpointInput
): Promise<MnemoWebhookEndpoint> {
  const idx = state.webhookEndpoints.findIndex((e) => e.id === id && e.workspaceId === workspaceId);
  if (idx === -1) throw new Error(`Webhook ${id} not found`);
  const existing = state.webhookEndpoints[idx]!;
  const updated: MnemoWebhookEndpoint = {
    ...existing,
    url: input.url ?? existing.url,
    events: input.events ?? existing.events,
    isActive: input.isActive ?? existing.isActive,
    description: input.description !== undefined ? input.description : existing.description,
    failureCount: input.failureCount ?? existing.failureCount,
    disabledAt: input.disabledAt !== undefined ? input.disabledAt : existing.disabledAt,
    updatedAt: new Date(),
  };
  state.webhookEndpoints[idx] = updated;
  return updated;
}

export async function deleteWebhookEndpoint(
  state: InMemoryStorageState,
  id: string,
  workspaceId: string
): Promise<void> {
  state.webhookEndpoints = state.webhookEndpoints.filter(
    (e) => !(e.id === id && e.workspaceId === workspaceId)
  );
}

export async function recordWebhookDelivery(
  state: InMemoryStorageState,
  entry: CreateWebhookDeliveryInput
): Promise<void> {
  state.webhookDeliveries.push({
    id: entry.id,
    webhookId: entry.webhookId,
    workspaceId: entry.workspaceId,
    eventType: entry.eventType,
    payload: entry.payload,
    status: entry.status,
    responseStatus: entry.responseStatus ?? null,
    responseBody: entry.responseBody ?? null,
    attempt: entry.attempt ?? 1,
    deliveredAt: entry.deliveredAt ?? null,
    nextAttemptAt: null,
    createdAt: new Date(),
  });
}

export async function listWebhookDeliveries(
  state: InMemoryStorageState,
  webhookId: string,
  workspaceId: string,
  limit = 50
): Promise<MnemoWebhookDelivery[]> {
  return state.webhookDeliveries
    .filter((d) => d.webhookId === webhookId && d.workspaceId === workspaceId)
    .slice(-limit)
    .reverse();
}

export async function listPendingWebhookDeliveries(
  state: InMemoryStorageState,
  limit: number
): Promise<MnemoWebhookDelivery[]> {
  const now = new Date();
  return state.webhookDeliveries
    .filter((d) => d.status === "pending" && (d.nextAttemptAt === null || d.nextAttemptAt <= now))
    .slice(0, limit);
}

export async function updateWebhookDelivery(
  state: InMemoryStorageState,
  id: string,
  workspaceId: string,
  update: {
    status?: "pending" | "delivered" | "failed";
    responseStatus?: number;
    responseBody?: string;
    attempt?: number;
    deliveredAt?: Date;
    nextAttemptAt?: Date | null;
  }
): Promise<void> {
  const idx = state.webhookDeliveries.findIndex(
    (d) => d.id === id && d.workspaceId === workspaceId
  );
  if (idx === -1) return;
  const existing = state.webhookDeliveries[idx]!;
  state.webhookDeliveries[idx] = {
    ...existing,
    status: update.status ?? existing.status,
    responseStatus: update.responseStatus ?? existing.responseStatus,
    responseBody: update.responseBody ?? existing.responseBody,
    attempt: update.attempt ?? existing.attempt,
    deliveredAt: update.deliveredAt !== undefined ? update.deliveredAt : existing.deliveredAt,
    nextAttemptAt:
      update.nextAttemptAt !== undefined ? update.nextAttemptAt : existing.nextAttemptAt,
  };
}
