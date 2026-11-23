/**
 * P120 — every archivable primitive projects its bitemporal interval.
 *
 * The bug: `mnemo_skill` (and entity, task, workflow) carry `valid_from` /
 * `valid_to`, `forget` closes the interval correctly, and the API projected
 * NEITHER field. So a forgotten skill came back from `get` byte-identical to a
 * live one. The archive was right; it was just invisible, which for a caller is
 * the same as not existing.
 *
 * It was not one route, either — that is what made it worth fixing rather than
 * documenting. `relation`, `hyperedge` and `reasoning` already projected the
 * pair, and `fact` always had. Half the primitives did the right thing, which
 * is exactly why the other half had no design argument behind it.
 *
 * This test is table-driven on purpose: the failure mode is "someone adds the
 * eighth primitive and forgets", and a per-route test would not notice. The
 * table is the contract.
 */
import { describe, it, expect } from "vitest";

import {
  entityToWire,
  taskToWire,
  eventToWire,
  hyperedgeToWire,
  relationToWire,
  reasoningToWire,
} from "../../routes/_mappers.js";

const T0 = new Date("2026-01-01T00:00:00.000Z");
const CLOSED = new Date("2026-06-01T00:00:00.000Z");

/** Enough of a row to drive a mapper; every mapper reads a different subset. */
function row(extra: Record<string, unknown> = {}): any {
  return {
    id: "id_1",
    workspaceId: "ws_1",
    name: "x",
    label: "x",
    title: "x",
    subject: "x",
    kind: "other",
    type: "system",
    description: "x",
    question: "x",
    conclusion: "x",
    chain: [],
    verb: "related",
    fromId: "a",
    toId: "b",
    fromKind: "fact",
    toKind: "fact",
    memberIds: [],
    tags: [],
    variables: [],
    requiredContext: [],
    linkedMemoryIds: [],
    annotations: [],
    relatedEntities: [],
    aliases: [],
    metadata: {},
    status: "active",
    sensitivity: "internal",
    confidence: 1,
    weight: 1,
    worth: 0.5,
    qualityScore: 0.5,
    usageCount: 0,
    mentionCount: 0,
    activationCount: 0,
    embeddingStale: false,
    firstSeenAt: T0,
    lastSeenAt: T0,
    occurredAt: T0,
    validFrom: T0,
    validTo: null,
    createdAt: T0,
    updatedAt: T0,
    ...extra,
  };
}

/**
 * `event` is deliberately absent: `MnemoEvent` has no `validTo` in the domain
 * type at all, because the event log is immutable by design — which is the same
 * fact `memory_event`'s own description discloses ("archiving an event is a
 * no-op"). Listing it here would demand a field whose absence is the feature.
 */
const BITEMPORAL = [
  ["entity", entityToWire],
  ["task", taskToWire],
  ["hyperedge", hyperedgeToWire],
  ["relation", relationToWire],
  ["reasoning", reasoningToWire],
] as const;

describe("P120 — bitemporal interval reaches the caller", () => {
  for (const [name, mapper] of BITEMPORAL) {
    it(`${name} projects validFrom and an open validTo`, () => {
      const wire = mapper(row()) as Record<string, unknown>;
      expect(wire.validFrom, `${name} dropped validFrom`).toBe(T0.toISOString());
      // `null`, explicitly — not absent. An absent key and a null one read the
      // same in JavaScript and completely differently in a JSON contract: the
      // first says "this concept does not apply here", the second says "still
      // open". Callers branch on that.
      expect(wire, `${name} dropped validTo`).toHaveProperty("validTo");
      expect(wire.validTo).toBeNull();
    });

    it(`${name} reports a CLOSED interval once archived`, () => {
      const wire = mapper(row({ validTo: CLOSED })) as Record<string, unknown>;
      expect(wire.validTo, `${name} loses the close timestamp`).toBe(CLOSED.toISOString());
    });
  }

  it("event is excluded on purpose, not by omission", () => {
    // If someone gives events a validTo, this fails and sends them to read
    // why the event log is immutable before wiring it up.
    const wire = eventToWire(row()) as Record<string, unknown>;
    expect("validTo" in wire, "events gained a validTo — see memory_event's own disclosure").toBe(
      false
    );
  });
});
