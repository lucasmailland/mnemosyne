/**
 * Unit tests for WebSocket subscription matching logic — pure, no socket.
 *
 * Tests matchesSubscription() which decides whether a bus event should
 * be pushed to a WS client based on:
 *  1. channelMatches(sub.channel, event.channel) — glob/exact match
 *  2. payload filter (entityId / agentId / memoryType)
 *  3. workspace isolation (payload.workspaceId must match subscriber's workspace)
 */

import { describe, it, expect } from "vitest";
import { matchesSubscription } from "../../ws.js";
import type { MnemoBusEvent } from "@mnemo-ai/types";

function makeEvent(channel: string, payload: Record<string, unknown> = {}): MnemoBusEvent {
  return {
    channel,
    type: "fact.created",
    payload: { workspaceId: "ws_test", ...payload },
    timestamp: new Date().toISOString(), // determinism-ok: throwaway fixture date, not asserted
    traceId: "trace-1",
  };
}

describe("matchesSubscription", () => {
  it("facts.* channel glob matches a fact.created event", () => {
    const result = matchesSubscription(
      { channel: "facts.*", workspaceId: "ws_test" },
      makeEvent("fact.created"),
    );
    expect(result).toBe(true);
  });

  it("tasks.* channel glob does NOT match a fact.created event", () => {
    const result = matchesSubscription(
      { channel: "tasks.*", workspaceId: "ws_test" },
      makeEvent("fact.created"),
    );
    expect(result).toBe(false);
  });

  it("exact channel match passes", () => {
    const result = matchesSubscription(
      { channel: "fact.created", workspaceId: "ws_test" },
      makeEvent("fact.created"),
    );
    expect(result).toBe(true);
  });

  it("entityId filter: matches when payload.id equals filter.entityId", () => {
    const result = matchesSubscription(
      { channel: "facts.*", workspaceId: "ws_test", filter: { entityId: "fact_abc" } },
      makeEvent("fact.created", { id: "fact_abc" }),
    );
    expect(result).toBe(true);
  });

  it("entityId filter: rejects when payload.id differs from filter.entityId", () => {
    const result = matchesSubscription(
      { channel: "facts.*", workspaceId: "ws_test", filter: { entityId: "fact_xyz" } },
      makeEvent("fact.created", { id: "fact_abc" }),
    );
    expect(result).toBe(false);
  });

  it("workspace isolation: rejects events from a different workspace", () => {
    const result = matchesSubscription(
      { channel: "facts.*", workspaceId: "ws_other" },
      makeEvent("fact.created", { workspaceId: "ws_test" }),
    );
    expect(result).toBe(false);
  });

  it("session channel subscription matches session.xyz event", () => {
    const result = matchesSubscription(
      { channel: "session.xyz", workspaceId: "ws_test" },
      makeEvent("session.xyz"),
    );
    expect(result).toBe(true);
  });
});
