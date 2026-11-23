import { describe, expect, it } from "vitest";
import { mapRowToOutbox } from "../repositories/mappers.js";

describe("mapRowToOutbox", () => {
  it("maps raw snake_case rows returned by claimOutbox", () => {
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    const claimedAt = new Date("2026-01-01T00:01:00.000Z");
    const processedAt = new Date("2026-01-01T00:02:00.000Z");

    const entry = mapRowToOutbox({
      id: "outbox-1",
      workspace_id: "workspace-1",
      event_type: "vector_upsert",
      payload: { id: "fact-1" },
      created_at: createdAt,
      claimed_at: claimedAt,
      processed_at: processedAt,
      attempts: 2,
      last_error: "temporary failure",
    } as never);

    expect(entry).toEqual({
      id: "outbox-1",
      workspaceId: "workspace-1",
      eventType: "vector_upsert",
      payload: { id: "fact-1" },
      createdAt,
      claimedAt,
      processedAt,
      attempts: 2,
      lastError: "temporary failure",
    });
  });
});
