import { describe, expect, it } from "vitest";
import { computeTerminalDigestV1 } from "@mnemo-ai/types/harness-runtime";
import { planReconciliation, type TranscriptMessage } from "../reconcile.js";
import type { MessageIdentity } from "../state.js";

const GENERATION = 0;

function transcript(
  ...entries: Array<[string, string, "user" | "assistant"?]>
): TranscriptMessage[] {
  return entries.map(([hostMessageId, content, role = "user"]) => ({
    hostMessageId,
    role,
    content,
    contentHash: `hash:${content}`,
  }));
}

function acknowledged(
  ...entries: Array<[string, string, Partial<MessageIdentity>?]>
): Record<string, MessageIdentity> {
  const map: Record<string, MessageIdentity> = {};
  for (const [hostMessageId, content, extra] of entries) {
    map[`${GENERATION}:${hostMessageId}`] = {
      type: "M",
      sourceGeneration: GENERATION,
      hostMessageId,
      role: "user",
      contentHash: `hash:${content}`,
      retracted: false,
      ...extra,
    };
  }
  return map;
}

const plan = (input: Partial<Parameters<typeof planReconciliation>[0]>) =>
  planReconciliation({
    sourceGeneration: GENERATION,
    transcript: [],
    acknowledgedMessages: {},
    pending: [],
    ...input,
  });

describe("diffing a transcript against what the server already has", () => {
  it("does nothing when the transcript matches what was acknowledged", () => {
    const result = plan({
      transcript: transcript(["m1", "hello"], ["m2", "world"]),
      acknowledgedMessages: acknowledged(["m1", "hello"], ["m2", "world"]),
    });

    expect(result).toMatchObject({ appends: [], retractions: [], cancellations: [] });
  });

  it("appends a message the server has never seen", () => {
    const result = plan({
      transcript: transcript(["m1", "hello"], ["m2", "recovered"]),
      acknowledgedMessages: acknowledged(["m1", "hello"]),
    });

    expect(result.appends).toEqual([
      expect.objectContaining({ hostMessageId: "m2", content: "recovered" }),
    ]);
    expect(result.retractions).toEqual([]);
  });

  it("supersedes an acknowledged message whose content changed", () => {
    const result = plan({
      transcript: transcript(["m1", "edited"]),
      acknowledgedMessages: acknowledged(["m1", "original"]),
    });

    // Editing is a new message that replaces the old one, never an in-place
    // rewrite: the server's copy of the original was already used.
    expect(result.appends).toEqual([
      expect.objectContaining({ hostMessageId: "m1", supersedesSourceMessageId: "m1" }),
    ]);
    expect(result.retractions).toEqual([
      expect.objectContaining({ hostMessageId: "m1", reason: "superseded" }),
    ]);
  });

  it("retracts an acknowledged message the transcript no longer has", () => {
    const result = plan({
      transcript: transcript(["m1", "hello"]),
      acknowledgedMessages: acknowledged(["m1", "hello"], ["m2", "on a dead branch"]),
    });

    expect(result.retractions).toEqual([
      expect.objectContaining({ hostMessageId: "m2", reason: "branch_removed" }),
    ]);
    expect(result.appends).toEqual([]);
  });

  it("does not retract twice what is already retracted", () => {
    const result = plan({
      transcript: transcript(["m1", "hello"]),
      acknowledgedMessages: acknowledged(["m1", "hello"], ["m2", "gone", { retracted: true }]),
    });

    expect(result.retractions).toEqual([]);
  });

  it("re-appends a message that comes back after being retracted", () => {
    const result = plan({
      transcript: transcript(["m1", "hello"], ["m2", "restored"]),
      acknowledgedMessages: acknowledged(["m1", "hello"], ["m2", "restored", { retracted: true }]),
    });

    expect(result.appends).toEqual([
      expect.objectContaining({ hostMessageId: "m2", supersedesSourceMessageId: "m2" }),
    ]);
  });
});

describe("respecting what is already queued", () => {
  const pendingAppend = (hostMessageId: string, content: string, eventId = `e-${hostMessageId}`) =>
    ({
      eventId,
      type: "turn.append",
      host: "codex",
      hostSessionId: "s",
      clientInstanceId: "c",
      enqueueSequence: 1,
      sourceGeneration: GENERATION,
      hostMessageId,
      role: "user",
      content,
      contentHash: `hash:${content}`,
      occurredAt: "2026-09-10T00:00:00.000Z",
      normalizationVersion: 1,
      payloadHash: "p",
    }) as never;

  it("does not re-append what is already waiting in the queue", () => {
    const result = plan({
      transcript: transcript(["m1", "hello"]),
      pending: [pendingAppend("m1", "hello")],
    });

    expect(result.appends).toEqual([]);
  });

  it("cancels a queued append whose message was revised before it was ever sent", () => {
    const result = plan({
      transcript: transcript(["m1", "edited"]),
      pending: [pendingAppend("m1", "original", "queued-1")],
    });

    // The queued copy is stale and nobody has seen it: cancel it rather than
    // delivering a version the transcript no longer shows.
    expect(result.cancellations).toEqual([expect.objectContaining({ targetEventId: "queued-1" })]);
    expect(result.appends).toEqual([
      expect.objectContaining({ hostMessageId: "m1", content: "edited" }),
    ]);
  });

  it("retracts a queued append after replay when its message vanished", () => {
    const result = plan({
      transcript: [],
      pending: [pendingAppend("m1", "never sent", "queued-1")],
    });

    expect(result.cancellations).toEqual([]);
    expect(result.retractions).toEqual([{ hostMessageId: "m1", reason: "branch_removed" }]);
  });

  const pendingCancel = (targetEventId: string) =>
    ({
      eventId: `cancel-${targetEventId}`,
      type: "event.cancel",
      host: "codex",
      hostSessionId: "s",
      clientInstanceId: "c",
      enqueueSequence: 2,
      sourceGeneration: GENERATION,
      targetEventId,
      reason: "terminal_rebuild",
      occurredAt: "2026-09-10T00:00:00.000Z",
      normalizationVersion: 1,
      payloadHash: "p",
    }) as never;

  it("does not cancel the same queued append twice when a close is retried", () => {
    const result = plan({
      transcript: [],
      pending: [pendingAppend("m1", "never sent", "queued-1"), pendingCancel("queued-1")],
    });

    expect(result.cancellations).toEqual([]);
    expect(result.retractions).toEqual([]);
  });

  it("treats a revised message as settled once its stale copy is cancelled and the new one queued", () => {
    const result = plan({
      transcript: transcript(["m1", "edited"]),
      pending: [
        pendingAppend("m1", "original", "queued-1"),
        pendingCancel("queued-1"),
        pendingAppend("m1", "edited", "queued-2"),
      ],
    });

    // Without this the next Stop would cancel and re-append forever.
    expect(result).toMatchObject({ appends: [], retractions: [], cancellations: [] });
  });
});

describe("the live set a terminal barrier is built from", () => {
  it("describes exactly the messages that survive reconciliation", () => {
    const result = plan({
      transcript: transcript(["m1", "kept"], ["m2", "new"]),
      acknowledgedMessages: acknowledged(["m1", "kept"], ["m3", "removed"]),
    });

    expect(result.liveSet.map((m) => m.hostMessageId).sort()).toEqual(["m1", "m2"]);
    // A digest over the live set is what the server checks the barrier against.
    expect(() => computeTerminalDigestV1(result.liveSet)).not.toThrow();
  });

  it("keeps a loss marker in the live set instead of pretending the gap is not there", () => {
    const result = plan({
      transcript: transcript(["m1", "kept"]),
      acknowledgedMessages: {
        ...acknowledged(["m1", "kept"]),
        [`${GENERATION}:m0`]: {
          type: "L",
          sourceGeneration: GENERATION,
          hostMessageId: "m0",
          role: "user",
          contentHash: "hash:lost",
          retracted: false,
          lossReason: "capacity",
          lostEventType: "turn.append",
        },
      },
    });

    // The message is gone, but the fact that something was there is not: dropping
    // it would make the digest claim a complete conversation that is not.
    expect(result.liveSet.find((m) => m.hostMessageId === "m0")).toMatchObject({ type: "L" });
    // And it is never re-appended: the content is not recoverable.
    expect(result.appends).toEqual([]);
  });

  it("excludes a retracted message from the live set", () => {
    const result = plan({
      transcript: transcript(["m1", "kept"]),
      acknowledgedMessages: acknowledged(["m1", "kept"], ["m2", "gone", { retracted: true }]),
    });

    expect(result.liveSet.map((m) => m.hostMessageId)).toEqual(["m1"]);
  });

  it("is stable under transcript ordering, so the digest is too", () => {
    const forward = plan({ transcript: transcript(["m1", "a"], ["m2", "b"]) });
    const reversed = plan({ transcript: transcript(["m2", "b"], ["m1", "a"]) });

    expect(computeTerminalDigestV1(forward.liveSet)).toBe(
      computeTerminalDigestV1(reversed.liveSet)
    );
  });
});

describe("whether a terminal barrier may be built at all", () => {
  it("refuses while reconciliation still owes the server work", () => {
    const result = plan({
      transcript: transcript(["m1", "hello"], ["m2", "unsent"]),
      acknowledgedMessages: acknowledged(["m1", "hello"]),
    });

    // A barrier claims "this is the whole conversation". Sending one before the
    // appends it describes would have the server verify a digest it cannot match.
    expect(result.terminalReady).toBe(false);
  });

  it("allows one once nothing is left to reconcile", () => {
    const result = plan({
      transcript: transcript(["m1", "hello"]),
      acknowledgedMessages: acknowledged(["m1", "hello"]),
    });

    expect(result.terminalReady).toBe(true);
  });

  it("refuses while an event is still queued but unsent", () => {
    const result = plan({
      transcript: transcript(["m1", "hello"]),
      acknowledgedMessages: {},
      pending: [
        {
          eventId: "queued-1",
          type: "turn.append",
          hostMessageId: "m1",
          sourceGeneration: GENERATION,
          role: "user",
          contentHash: "hash:hello",
          enqueueSequence: 1,
        } as never,
      ],
    });

    expect(result.terminalReady).toBe(false);
  });

  it("preserves compacted messages in the live set without retracting them as branch_removed", () => {
    const result = plan({
      transcript: transcript(["m3", "post-compaction"]),
      acknowledgedMessages: acknowledged(["m1", "compacted-user"], ["m2", "compacted-assistant"]),
      compactedMessageIds: ["m1", "m2"],
    });

    expect(result.retractions).toEqual([]);
    expect(result.appends.map((a) => a.hostMessageId)).toEqual(["m3"]);
    expect(result.liveSet.map((m) => m.hostMessageId).sort()).toEqual(["m1", "m2", "m3"]);
  });

  it("refuses terminal readiness when a chunked message has partially acknowledged chunks and missing pending chunks", () => {
    const result = plan({
      transcript: transcript(["m1", "large-message"]),
      acknowledgedMessages: {},
      acknowledgedMessageChunks: {
        [`${GENERATION}:m1`]: {
          sourceGeneration: GENERATION,
          hostMessageId: "m1",
          role: "assistant",
          chunkCount: 2,
          messageContentHash: "hash:large-message",
          chunks: { "0": "hash:chunk-0" },
        },
      },
      pending: [],
    });

    expect(result.terminalReady).toBe(false);
  });
});
