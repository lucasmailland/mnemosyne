import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  OPENCODE_CHANNELS,
  OPENCODE_SESSION_EVENTS,
  buildManagedMarker,
  toTranscriptMessages,
  toVisibleMessage,
  validateManagedMarker,
} from "../opencode.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const contract = JSON.parse(
  readFileSync(join(HERE, "..", "..", "..", "fixtures", "opencode-events.json"), "utf8")
) as {
  hooks: string[];
  sessionEvents: string[];
  channels: Record<string, string>;
  recordedFrom: Record<string, string>;
};

describe("the native contract this adapter depends on", () => {
  it("uses only channels the recorded host actually exposes", () => {
    // The lesson from other projects: subscribing to a name that does not exist
    // captures nothing, silently, for months. Pin it so a rename fails here.
    for (const channel of Object.values(OPENCODE_CHANNELS)) {
      expect(contract.hooks).toContain(channel);
    }
  });

  it("uses only session events the recorded host actually emits", () => {
    for (const event of Object.values(OPENCODE_SESSION_EVENTS)) {
      expect(contract.sessionEvents).toContain(event);
    }
  });

  it("names the exact build it was recorded from", () => {
    expect(contract.recordedFrom.hostBinaryVersion).toBeTruthy();
    expect(contract.recordedFrom.pluginPackage).toBeTruthy();
    expect(contract.recordedFrom.platform).toBeTruthy();
  });

  it("injects through the system-prompt channel, which survives compaction", () => {
    expect(OPENCODE_CHANNELS.systemPrompt).toBe("experimental.chat.system.transform");
  });
});

describe("mapping a native user message", () => {
  const native = {
    sessionID: "ses_abc123",
    message: { id: "msg_001", role: "user" },
    parts: [
      { type: "text", text: "hello " },
      { type: "file", filename: "ignored.png" },
      { type: "text", text: "world" },
    ],
  };

  it("produces exactly what the outbox needs, and nothing more", () => {
    const result = toVisibleMessage(native as never, { clientInstanceId: "client-a" });

    expect(result).toMatchObject({
      host: "opencode",
      hostSessionId: "ses_abc123",
      clientInstanceId: "client-a",
      hostMessageId: "msg_001",
      role: "user",
      content: "hello world",
    });
  });

  it("uses the host's own message id, so the same message is one identity", () => {
    const a = toVisibleMessage(native as never, { clientInstanceId: "c" });
    const b = toVisibleMessage(native as never, { clientInstanceId: "c" });
    expect(a.hostMessageId).toBe(b.hostMessageId);
  });

  it("returns null for a payload it cannot identify, rather than inventing one", () => {
    for (const broken of [
      {},
      { sessionID: "s" },
      { sessionID: "s", message: {} },
      { sessionID: "s", message: { id: "m", role: "system" } },
      { sessionID: "s", message: { id: "m", role: "user" }, parts: [] },
    ]) {
      expect(toVisibleMessage(broken as never, { clientInstanceId: "c" })).toBeNull();
    }
  });
});

describe("reading a transcript the host handed us", () => {
  const messages = [
    { id: "m1", role: "user", parts: [{ type: "text", text: "question" }] },
    { id: "m2", role: "assistant", parts: [{ type: "text", text: "answer" }] },
    { id: "m3", role: "system", parts: [{ type: "text", text: "not visible" }] },
    { id: "m4", role: "assistant", parts: [{ type: "tool", name: "bash" }] },
  ];

  it("keeps only what a human actually saw", () => {
    const result = toTranscriptMessages(messages as never);

    // System prompts and tool calls are not conversation; capturing them would
    // store machinery as though it were what the user said.
    expect(result.map((m) => m.hostMessageId)).toEqual(["m1", "m2"]);
    expect(result[1]).toMatchObject({ role: "assistant", content: "answer" });
  });

  it("hashes content so reconciliation can tell an edit from a repeat", () => {
    const [first] = toTranscriptMessages(messages as never);
    expect(first!.contentHash).toMatch(/^[0-9a-f]{64}$/);
    const edited = toTranscriptMessages([
      { id: "m1", role: "user", parts: [{ type: "text", text: "question, edited" }] },
    ] as never);
    expect(edited[0]!.contentHash).not.toBe(first!.contentHash);
  });

  it("never opens a path of its own", () => {
    // Reconciliation is handed messages by a trusted reader. If this function
    // took a path, a hostile transcript location would become a file read.
    expect(toTranscriptMessages.length).toBe(1);
  });
});

describe("the managed marker", () => {
  const identity = {
    host: "opencode",
    clientInstanceId: "client-a",
    hostSessionId: "ses_abc",
    sourceGeneration: 0,
  };
  /** A queue that has had something acknowledged: generation 0 is mapped. */
  const managed = { acknowledgedWatermark: 7, generationMappings: { "0": 3 } };

  it("names the session it belongs to, in the documented form", () => {
    expect(buildManagedMarker(identity)).toBe("mnemo-managed-v1:opencode:client-a:ses_abc:0");
  });

  it("validates a marker for a session this queue really is managing", () => {
    expect(
      validateManagedMarker(buildManagedMarker(identity), { identity, state: managed as never })
    ).toBe(true);
  });

  it("rejects a marker whose generation nothing has acknowledged", () => {
    // This is the case that matters: before the first acknowledgement there is
    // no valid marker at all, which is exactly when a forged one would do the
    // most damage. Guessing the shape, and guessing generation 0, is not enough.
    const fresh = { acknowledgedWatermark: 0, generationMappings: {} };
    expect(
      validateManagedMarker(buildManagedMarker(identity), { identity, state: fresh as never })
    ).toBe(false);
  });

  it("rejects a hand-typed lookalike", () => {
    for (const forged of [
      "mnemo-managed-v1:opencode:client-a:ses_abc:0 trust-me",
      "mnemo-managed-v1: opencode:client-a:ses_abc:0",
      "mnemo-managed:opencode:client-a:ses_abc:0",
      "managed",
      "",
      42,
      null,
    ]) {
      expect(validateManagedMarker(forged as never, { identity, state: managed as never })).toBe(
        false
      );
    }
  });

  it("rejects a marker built for another session, client or host", () => {
    for (const other of [
      { ...identity, hostSessionId: "ses_other" },
      { ...identity, clientInstanceId: "client-b" },
      { ...identity, host: "codex" },
      { ...identity, sourceGeneration: 1 },
    ]) {
      expect(
        validateManagedMarker(buildManagedMarker(other), { identity, state: managed as never })
      ).toBe(false);
    }
  });

  it("never carries captured content", () => {
    const marker = buildManagedMarker(identity);
    expect(marker).not.toMatch(/hello|world|question|answer/);
  });
});
