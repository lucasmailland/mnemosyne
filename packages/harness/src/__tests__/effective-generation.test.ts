import { beforeEach, expect, it, vi } from "vitest";

// Keep state semantics independent of native locking and filesystem ownership.
// The real filesystem and process exclusion have their own contract tests.
const files = vi.hoisted(() => new Map<string, string>());
vi.mock("../fs-security.js", () => ({
  ensureSecureHarnessPaths: async () => ({ state: "/state" }),
  sessionLockName: (key: string) => key,
  withAdvisoryLock: async (_paths: unknown, _name: string, operation: () => unknown) => operation(),
  atomicWritePrivateFile: async (path: string, content: string) => {
    files.set(path, content);
  },
  readPrivateFile: async (path: string) => {
    if (!files.has(path)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return files.get(path);
  },
  recoverAtomicTemporaryFiles: async () => ({ discarded: 0 }),
}));
import { ensureSecureHarnessPaths } from "../fs-security.js";
import {
  acknowledgeEvent,
  computeAcknowledgementIdentityHash,
  readSessionState,
  recordEnqueuedSequence,
  type AcknowledgedEvent,
} from "../state.js";

beforeEach(() => files.clear());
const append = (
  sequence: number,
  hostMessageId: string
): Extract<AcknowledgedEvent, { type: "turn.append" }> => ({
  type: "turn.append",
  eventId: `event-${sequence}`,
  enqueueSequence: sequence,
  sourceGeneration: 0,
  hostMessageId,
  role: "user",
  contentHash: "a".repeat(64),
});
async function accept(event: AcknowledgedEvent, effectiveGeneration: number) {
  const paths = await ensureSecureHarnessPaths();
  await recordEnqueuedSequence(
    "claude-code",
    "client",
    "session",
    event.enqueueSequence,
    computeAcknowledgementIdentityHash(event as unknown as Record<string, unknown>),
    paths
  );
  return acknowledgeEvent("claude-code", "client", "session", event, { effectiveGeneration });
}
const read = () => readSessionState("claude-code", "client", "session");

it("owns each occurrence by its ACK generation and preserves the requested replay identity", async () => {
  await accept(append(1, "earlier"), 0);
  const redirected = append(2, "later");
  await accept(redirected, 1);
  const state = await read();
  expect(state.acknowledgedMessages["0:earlier"]).toMatchObject({ sourceGeneration: 0 });
  expect(state.acknowledgedMessages["1:later"]).toMatchObject({ sourceGeneration: 1 });
  expect(state.acknowledgedMessages["0:later"]).toBeUndefined();
  await expect(
    acknowledgeEvent("claude-code", "client", "session", redirected, { effectiveGeneration: 1 })
  ).resolves.toMatchObject({ acknowledgedWatermark: 2 });
});

it.each([false, true])(
  "moves staged ACK fragments with their successor, reversed ACK order: %s",
  async (reverse) => {
    const chunk = {
      version: 1 as const,
      chunkIndex: 0,
      chunkCount: 2,
      messageContentHash: "f".repeat(64),
    };
    const first = { ...append(1, "chunked"), chunk };
    const second = { ...append(2, "chunked"), chunk: { ...chunk, chunkIndex: 1 } };
    if (reverse) {
      await accept(second, 1);
      await accept(first, 0);
    } else {
      await accept(first, 0);
      await accept(second, 1);
    }
    const state = await read();
    expect(state.acknowledgedMessageChunks ?? {}).toEqual({});
    expect(Object.values(state.acknowledgedMessages)).toEqual([
      expect.objectContaining({
        hostMessageId: "chunked",
        sourceGeneration: 1,
        contentHash: chunk.messageContentHash,
      }),
    ]);
  }
);

it("keeps a retracted predecessor identity in place when the retraction belongs to its successor", async () => {
  await accept(append(1, "earlier"), 0);
  await accept(
    {
      type: "turn.retract",
      eventId: "retraction",
      enqueueSequence: 2,
      sourceGeneration: 0,
      hostMessageId: "earlier",
      reason: "branch_removed",
    },
    1
  );
  const state = await read();
  expect(state.acknowledgedMessages["0:earlier"]).toMatchObject({ retracted: true });
  expect(state.acknowledgedEvents.retraction).toMatchObject({ effectiveGeneration: 1 });
});
