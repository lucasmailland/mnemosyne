import { createHash } from "node:crypto";

/**
 * Codex CLI hook translation. Nothing else.
 *
 * Codex's hook system is shaped like Claude Code's, with two differences that
 * matter and one quirk that will silently fail a hook if ignored.
 */

export const CODEX_EVENTS = {
  sessionStart: "SessionStart",
  userPromptSubmit: "UserPromptSubmit",
  /** Per-reply, like Claude Code's. Not a close. */
  stop: "Stop",
  preCompact: "PreCompact",
  sessionEnd: "SessionEnd",
} as const;

export type CodexEvent = (typeof CODEX_EVENTS)[keyof typeof CODEX_EVENTS];

/** Only SessionEnd ends the session; Stop fires on every reply. */
export function isSessionClose(event: string): boolean {
  return event === CODEX_EVENTS.sessionEnd;
}

export interface CodexCaptureGate {
  capturable: boolean;
  mode: "full" | "mcp-only";
  reason: string;
}

/**
 * The two gates in front of Codex capture.
 *
 * Both are real and both fail SILENTLY if ignored: hooks are behind
 * `features.hooks`, which defaults OFF, and hooks do not exist on Windows at
 * all. Installing a hook manifest in either case looks completely successful and
 * captures nothing — which is the failure mode this whole qualification
 * mechanism exists to prevent.
 *
 * The platform is reported first when both apply, because telling a Windows user
 * to flip a flag that cannot help them is worse than telling them the truth.
 */
export function codexCaptureGate(input: {
  platform: string;
  hooksEnabled: boolean;
}): CodexCaptureGate {
  if (input.platform === "win32") {
    return {
      capturable: false,
      mode: "mcp-only",
      reason: "Codex hooks are not available on Windows; MCP remains available",
    };
  }
  if (!input.hooksEnabled) {
    return {
      capturable: false,
      mode: "mcp-only",
      reason: "Codex hooks require features.hooks = true in config.toml (it defaults off)",
    };
  }
  return { capturable: true, mode: "full", reason: "hooks are enabled on a supported platform" };
}

export interface CodexHookResponse {
  hookSpecificOutput: { hookEventName: string; additionalContext: string };
}

/**
 * The response every Codex hook must return.
 *
 * Codex's SessionStart validator REJECTS a bare `{"continue": true}` — it needs a
 * well-formed `hookSpecificOutput` carrying at least an empty `additionalContext`.
 * A rejected hook fails rather than degrades, so this shape is always emitted,
 * for every event, whether or not there is anything to inject.
 */
export function hookResponse(event: string, additionalContext: string): CodexHookResponse {
  return {
    hookSpecificOutput: {
      hookEventName: event,
      additionalContext: additionalContext ?? "",
    },
  };
}

export interface CodexVisibleMessage {
  host: "codex";
  hostSessionId: string;
  clientInstanceId: string;
  sourceGeneration: number;
  hostMessageId: string;
  role: "user";
  content: string;
}

/**
 * A UserPromptSubmit payload as something the outbox can accept.
 *
 * Like Claude Code, Codex sends no message id, so a stable one is derived from
 * the session and the prompt: a redelivered hook must not become a second
 * message.
 */
export function toVisibleMessage(
  payload: { session_id?: string; prompt?: string },
  context: { clientInstanceId: string; sourceGeneration?: number }
): CodexVisibleMessage | null {
  const hostSessionId = payload?.session_id;
  const prompt = payload?.prompt;
  if (typeof hostSessionId !== "string" || hostSessionId.length === 0) return null;
  if (typeof prompt !== "string" || prompt.length === 0) return null;

  return {
    host: "codex",
    hostSessionId,
    clientInstanceId: context.clientInstanceId,
    sourceGeneration: context.sourceGeneration ?? 0,
    hostMessageId: createHash("sha256")
      .update(`${hostSessionId} ${prompt}`, "utf8")
      .digest("hex")
      .slice(0, 32),
    role: "user",
    content: prompt,
  };
}
