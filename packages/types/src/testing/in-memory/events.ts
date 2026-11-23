// in-memory/events.ts — InMemoryStorageAdapter's Event port methods.
// decompose-inmemory-storage-adapter Batch B4 (design.md Module Map row 15).
// Bodies moved verbatim from InMemoryStorageAdapter.ts — the only edit is
// `this.<field>` → `state.<field>` (design.md D7 move-only rule).

import type { CreateEventInput, EventFilter } from "../../ports.js";
import type { MnemoEvent } from "../../primitives.js";
import type { PaginatedResult } from "../../common.js";
import type { InMemoryStorageState } from "./state.js";
import { uuid, paginate } from "./support.js";
import { projectPrimitiveText } from "../../indexing.js";

export async function createEvent(
  state: InMemoryStorageState,
  input: CreateEventInput
): Promise<MnemoEvent> {
  const now = new Date();
  const event = {
    id: uuid(),
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    userId: input.userId,
    actorType: input.actorType,
    type: input.type,
    name: input.name,
    description: input.description,
    occurredAt: input.occurredAt,
    durationS: input.durationS,
    source: input.source,
    relatedEntities: input.relatedEntities ?? [],
    annotations: input.annotations ?? [],
    sensitivity: input.sensitivity ?? "internal",
    createdAt: now,
    metadata: input.metadata ?? {},
  } as unknown as MnemoEvent;
  state.events.set(event.id, event);
  // P65: mirrors the real adapter's in-transaction text-form vector_upsert.
  // Deliberately kept in step: a double that indexes nothing while Postgres
  // does (or vice versa) makes every unit test agree with the wrong thing —
  // the shape P116 hid behind for as long as it did.
  state.outbox.push({
    id: uuid(),
    workspaceId: event.workspaceId,
    eventType: "vector_upsert",
    payload: {
      id: event.id,
      kind: "event",
      text: projectPrimitiveText("event", event as unknown as Record<string, unknown>),
    },
    createdAt: new Date(),
    attempts: 0,
  });
  return event;
}

export async function getEvent(
  state: InMemoryStorageState,
  id: string,
  workspaceId: string
): Promise<MnemoEvent | null> {
  const e = state.events.get(id);
  return e && e.workspaceId === workspaceId ? e : null;
}

export async function archiveEvent(
  state: InMemoryStorageState,
  id: string,
  workspaceId: string
): Promise<void> {
  const e = state.events.get(id);
  if (e && e.workspaceId === workspaceId) {
    state.events.delete(id);
  }
}

export async function appendEventAnnotation(
  state: InMemoryStorageState,
  id: string,
  workspaceId: string,
  annotation: { author: string; content: string; at: Date }
): Promise<MnemoEvent> {
  const event = [...state.events.values()].find(
    (e) => e.id === id && e.workspaceId === workspaceId
  );
  if (!event) throw new Error(`Event not found: ${id}`);
  const updated: MnemoEvent = {
    ...event,
    annotations: [...(event.annotations ?? []), annotation],
  };
  state.events.set(id, updated);
  return updated;
}

export async function queryEvents(
  state: InMemoryStorageState,
  filter: EventFilter
): Promise<PaginatedResult<MnemoEvent>> {
  const items = [...state.events.values()].filter((e) => e.workspaceId === filter.workspaceId);
  return paginate(items, filter.offset, filter.limit);
}

export async function updateEventSensitivity(
  state: InMemoryStorageState,
  id: string,
  workspaceId: string,
  sensitivity: MnemoEvent["sensitivity"]
): Promise<void> {
  const event = state.events.get(id);
  if (event && event.workspaceId === workspaceId) {
    state.events.set(id, { ...event, sensitivity });
  }
}
