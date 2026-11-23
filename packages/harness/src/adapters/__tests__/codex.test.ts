import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CODEX_EVENTS,
  codexCaptureGate,
  hookResponse,
  isSessionClose,
  toVisibleMessage,
} from "../codex.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const contract = JSON.parse(
  readFileSync(join(HERE, "..", "..", "..", "fixtures", "codex-events.json"), "utf8")
) as { hookEvents: string[]; gates: Record<string, unknown>; channels: Record<string, string> };

describe("the Codex contract this adapter depends on", () => {
  it("subscribes only to events Codex defines", () => {
    for (const event of Object.values(CODEX_EVENTS)) {
      expect(contract.hookEvents).toContain(event);
    }
  });

  it("records that hooks are gated off by default", () => {
    expect(contract.gates.featureFlag).toBe("features.hooks");
    expect(contract.gates.featureFlagDefault).toBe(false);
  });

  it("treats SessionEnd as the close, not Stop", () => {
    expect(isSessionClose(CODEX_EVENTS.sessionEnd)).toBe(true);
    expect(isSessionClose(CODEX_EVENTS.stop)).toBe(false);
  });
});

describe("the two gates before Codex may be captured at all", () => {
  it("captures when hooks are enabled on a supported platform", () => {
    expect(codexCaptureGate({ platform: "darwin", hooksEnabled: true })).toMatchObject({
      capturable: true,
    });
  });

  it("degrades to MCP-only when the feature flag is off", () => {
    const gate = codexCaptureGate({ platform: "darwin", hooksEnabled: false });
    // features.hooks defaults off. Installing hooks without it would look
    // successful and capture nothing.
    expect(gate).toMatchObject({ capturable: false, mode: "mcp-only" });
    expect(gate.reason).toMatch(/features\.hooks/);
  });

  it("degrades to MCP-only on Windows, where Codex has no hooks at all", () => {
    const gate = codexCaptureGate({ platform: "win32", hooksEnabled: true });
    expect(gate).toMatchObject({ capturable: false, mode: "mcp-only" });
    expect(gate.reason).toMatch(/windows/i);
  });

  it("names the platform gate before the feature gate, since it cannot be fixed", () => {
    const gate = codexCaptureGate({ platform: "win32", hooksEnabled: false });
    // Telling a Windows user to flip a flag that will not help them is worse
    // than telling them the platform is unsupported.
    expect(gate.reason).toMatch(/windows/i);
  });
});

describe("answering a Codex hook", () => {
  it("always emits a well-formed hookSpecificOutput", () => {
    const response = hookResponse(CODEX_EVENTS.sessionStart, "");
    expect(response).toMatchObject({
      hookSpecificOutput: {
        hookEventName: CODEX_EVENTS.sessionStart,
        additionalContext: "",
      },
    });
  });

  it("never answers SessionStart with a bare continue", () => {
    // Codex's SessionStart validator rejects {"continue":true} outright, which
    // fails the hook rather than degrading it.
    const serialized = JSON.stringify(hookResponse(CODEX_EVENTS.sessionStart, ""));
    expect(serialized).toContain("hookSpecificOutput");
    expect(serialized).toContain("additionalContext");
  });

  it("carries injected context through the supported channel", () => {
    const response = hookResponse(CODEX_EVENTS.sessionStart, "mnemosyne-managed: ses-1 abc");
    expect(response.hookSpecificOutput.additionalContext).toContain("mnemosyne-managed");
  });
});

describe("mapping a user prompt", () => {
  const payload = { session_id: "ses-9", prompt: "explain this" };

  it("produces what the outbox needs", () => {
    expect(toVisibleMessage(payload as never, { clientInstanceId: "c" })).toMatchObject({
      host: "codex",
      hostSessionId: "ses-9",
      role: "user",
      content: "explain this",
    });
  });

  it("derives a stable id, since Codex sends no message id", () => {
    const a = toVisibleMessage(payload as never, { clientInstanceId: "c" });
    const b = toVisibleMessage(payload as never, { clientInstanceId: "c" });
    expect(a!.hostMessageId).toBe(b!.hostMessageId);
  });

  it("returns null rather than inventing a message", () => {
    for (const broken of [{}, { session_id: "s" }, { prompt: "orphan" }]) {
      expect(toVisibleMessage(broken as never, { clientInstanceId: "c" })).toBeNull();
    }
  });
});
