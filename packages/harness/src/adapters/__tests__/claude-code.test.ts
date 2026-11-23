import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CLAUDE_CODE_EVENTS,
  isSessionClose,
  toTranscriptMessages,
  toVisibleMessage,
} from "../claude-code.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const contract = JSON.parse(
  readFileSync(join(HERE, "..", "..", "..", "fixtures", "claude-code-events.json"), "utf8")
) as { hookEvents: string[]; payloadFields: string[]; channels: Record<string, string> };

const subagentFixture = JSON.parse(
  readFileSync(join(HERE, "..", "..", "..", "fixtures", "claude-code-subagent-stop.json"), "utf8")
) as {
  provenance: {
    kind: string;
    host: string;
    hostBinaryVersion: string;
    platform: string;
    event: string;
    sanitized: boolean;
  };
  documentedFields: string[];
  observedFields: string[];
  observedPayload: Record<string, unknown>;
  resume: { observed: boolean; sessionIdPreserved: boolean };
  contractCitation: string;
};

describe("SubagentStop native payload evidence", () => {
  it("is a genuine observation of SubagentStop from a pinned host binary", () => {
    expect(subagentFixture.provenance.kind).toBe("observed");
    expect(subagentFixture.provenance.host).toBe("claude-code");
    expect(subagentFixture.provenance.event).toBe("SubagentStop");
    expect(subagentFixture.provenance.hostBinaryVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(subagentFixture.provenance.platform.length).toBeGreaterThan(0);
    expect(subagentFixture.observedPayload.hook_event_name).toBe("SubagentStop");
  });

  it("separates documented fields from observed fields and lists exactly the observed keys", () => {
    expect(subagentFixture.observedFields).toEqual(
      Object.keys(subagentFixture.observedPayload).sort()
    );
    for (const field of subagentFixture.documentedFields) {
      expect(subagentFixture.observedFields).toContain(field);
    }
    const undocumented = subagentFixture.observedFields.filter(
      (f) => !subagentFixture.documentedFields.includes(f)
    );
    expect(undocumented).toContain("last_assistant_message");
  });

  it("cannot be satisfied by the old generic payloadFields list", () => {
    expect(contract.payloadFields).not.toContain("last_assistant_message");
    expect(contract.payloadFields).not.toContain("stdout");
    expect(subagentFixture.observedFields.every((f) => contract.payloadFields.includes(f))).toBe(
      false
    );
  });

  it("records resume session-ID behaviour as observed", () => {
    expect(subagentFixture.resume.observed).toBe(true);
    expect(subagentFixture.resume.sessionIdPreserved).toBe(true);
  });

  it("carries only synthetic canary text and redacted locations", () => {
    const raw = readFileSync(
      join(HERE, "..", "..", "..", "fixtures", "claude-code-subagent-stop.json"),
      "utf8"
    );
    expect(subagentFixture.provenance.sanitized).toBe(true);
    expect(String(subagentFixture.observedPayload.last_assistant_message)).toContain("SS01_CANARY");
    expect(String(subagentFixture.observedPayload.session_id)).toMatch(/^<redacted/);
    expect(String(subagentFixture.observedPayload.transcript_path)).toMatch(/^<redacted/);
    expect(raw).not.toMatch(/\/home\/pablo/);
    expect(raw).not.toMatch(/311e5e04-2b28-4ffc-96e3-db15269e5651/);
  });

  it("is cited against the official hook contract and mirrored in the events fixture", () => {
    expect(subagentFixture.contractCitation).toBe(
      "docs/internals/host-hook-contracts.md#claude-code--full-hooks"
    );
    const events = JSON.parse(
      readFileSync(join(HERE, "..", "..", "..", "fixtures", "claude-code-events.json"), "utf8")
    ) as {
      subagentStopEvidence: {
        hostBinaryVersion: string;
        platform: string;
        observedFields: string[];
        resumeSessionIdPreserved: boolean;
        contractCitation: string;
      };
    };
    expect(events.subagentStopEvidence.hostBinaryVersion).toBe(
      subagentFixture.provenance.hostBinaryVersion
    );
    expect(events.subagentStopEvidence.platform).toBe(subagentFixture.provenance.platform);
    expect(events.subagentStopEvidence.observedFields).toEqual(subagentFixture.observedFields);
    expect(events.subagentStopEvidence.resumeSessionIdPreserved).toBe(true);
    expect(events.subagentStopEvidence.contractCitation).toBe(subagentFixture.contractCitation);
  });
});

describe("the hook contract this adapter depends on", () => {
  it("subscribes only to events the host actually defines", () => {
    for (const event of Object.values(CLAUDE_CODE_EVENTS)) {
      expect(contract.hookEvents).toContain(event);
    }
  });

  it("reads only payload fields the host actually sends", () => {
    for (const field of ["session_id", "transcript_path", "prompt"]) {
      expect(contract.payloadFields).toContain(field);
    }
  });
});

describe("what counts as a session closing", () => {
  it("treats SessionEnd as the close", () => {
    expect(isSessionClose(CLAUDE_CODE_EVENTS.sessionEnd)).toBe(true);
  });

  it("does NOT treat Stop as the close", () => {
    // Stop fires when the assistant finishes a REPLY, which is every single turn.
    // Collapsing there would end the session after the user's first message and
    // scatter the rest across sessions that never close.
    expect(isSessionClose(CLAUDE_CODE_EVENTS.stop)).toBe(false);
  });

  it("does not treat compaction as the close either", () => {
    // Compaction is the moment context is about to be lost, which is when
    // reconciliation matters most — not when the conversation is over.
    expect(isSessionClose(CLAUDE_CODE_EVENTS.preCompact)).toBe(false);
  });
});

describe("mapping a user prompt", () => {
  const payload = {
    hook_event_name: "UserPromptSubmit",
    session_id: "ses-123",
    prompt: "what does this function do?",
    cwd: "/repo",
  };

  it("produces what the outbox needs", () => {
    expect(toVisibleMessage(payload as never, { clientInstanceId: "client-a" })).toMatchObject({
      host: "claude-code",
      hostSessionId: "ses-123",
      role: "user",
      content: "what does this function do?",
    });
  });

  it("derives a stable message id from the session and prompt", () => {
    const a = toVisibleMessage(payload as never, { clientInstanceId: "c" });
    const b = toVisibleMessage(payload as never, { clientInstanceId: "c" });
    // Claude Code gives a hook no message id, so one is derived. It has to be
    // stable, or a redelivered hook becomes a duplicate message.
    expect(a!.hostMessageId).toBe(b!.hostMessageId);
    expect(a!.hostMessageId).toMatch(/^[0-9a-f]{32}$/);
  });

  it("gives different prompts different identities", () => {
    const other = toVisibleMessage({ ...payload, prompt: "something else" } as never, {
      clientInstanceId: "c",
    });
    expect(other!.hostMessageId).not.toBe(
      toVisibleMessage(payload as never, { clientInstanceId: "c" })!.hostMessageId
    );
  });

  it("returns null rather than inventing a message", () => {
    for (const broken of [
      {},
      { session_id: "s" },
      { session_id: "s", prompt: "" },
      { prompt: "orphan" },
    ]) {
      expect(toVisibleMessage(broken as never, { clientInstanceId: "c" })).toBeNull();
    }
  });
});

describe("reading a transcript the caller already loaded", () => {
  const lines = [
    { type: "user", uuid: "u1", message: { role: "user", content: "question" } },
    {
      type: "assistant",
      uuid: "a1",
      message: { role: "assistant", content: [{ type: "text", text: "answer" }] },
    },
    { type: "system", uuid: "s1", message: { role: "system", content: "noise" } },
    {
      type: "assistant",
      uuid: "a2",
      message: { role: "assistant", content: [{ type: "tool_use", name: "bash" }] },
    },
  ];

  it("keeps only what a human actually saw", () => {
    const result = toTranscriptMessages(lines as never);
    expect(result.map((m) => m.hostMessageId)).toEqual(["u1", "a1"]);
    expect(result[1]).toMatchObject({ role: "assistant", content: "answer" });
  });

  it("takes parsed entries, never a path", () => {
    // transcript_path arrives in the hook payload from the host. Opening it here
    // would make a hostile path an arbitrary file read inside the user's session.
    expect(toTranscriptMessages.length).toBe(1);
  });

  it("hashes content so an edit is distinguishable from a repeat", () => {
    const [first] = toTranscriptMessages(lines as never);
    expect(first!.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("turn content origin", () => {
  it("keeps native classification, conservative wrappers, mixed and escaped text distinct", () => {
    const entries = [
      {
        uuid: "human",
        message: { role: "user", content: "hello" },
        turnOrigin: "human",
        turnOriginEvidence: "host:user_input",
      },
      {
        uuid: "agent",
        message: { role: "user", content: "<agent-message>result</agent-message>" },
      },
      {
        uuid: "task",
        message: { role: "user", content: "<task-notification>done</task-notification>" },
      },
      {
        uuid: "paste",
        message: { role: "user", content: "<pasted_content>text</pasted_content>" },
      },
      {
        uuid: "mixed",
        message: { role: "user", content: "My words <agent-message>result</agent-message>" },
      },
      {
        uuid: "escaped",
        message: { role: "user", content: "&lt;agent-message&gt;result&lt;/agent-message&gt;" },
      },
      { uuid: "assistant", message: { role: "assistant", content: "answer" } },
    ];
    const messages = toTranscriptMessages(entries);
    expect(messages.map((m) => m.turnOrigin)).toEqual([
      "human",
      "agent_message",
      "task_notification",
      "pasted_content",
      "unknown",
      "unknown",
      "assistant",
    ]);
    expect(messages.map((m) => m.content)).toEqual(entries.map((e) => e.message.content));
  });
});
