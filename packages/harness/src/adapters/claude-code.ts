import { classifyTurnOrigin } from "@mnemo-ai/types/harness-runtime";
import type { TurnOrigin } from "../content-origin.js";
import { createHash } from "node:crypto";
import { normalizeVisibleMessage } from "../sanitize.js";
import type { TranscriptMessage } from "../reconcile.js";

/**
 * Claude Code hook translation. Nothing else.
 *
 * Hooks run synchronously in the user's session, so this module does no I/O and
 * makes no network call: it turns a payload into a canonical shape and returns.
 */

export const CLAUDE_CODE_EVENTS = {
  sessionStart: "SessionStart",
  userPromptSubmit: "UserPromptSubmit",
  /** Fires when the assistant finishes a REPLY. Not a close. See isSessionClose. */
  stop: "Stop",
  preCompact: "PreCompact",
  sessionEnd: "SessionEnd",
} as const;

export type ClaudeCodeEvent = (typeof CLAUDE_CODE_EVENTS)[keyof typeof CLAUDE_CODE_EVENTS];

/**
 * Whether an event ends the session.
 *
 * Only SessionEnd does. This corrects an older contract that treated Stop as the
 * close: Stop fires every time the assistant finishes a reply, so collapsing
 * there would end the session after the user's first message and scatter the
 * rest of the conversation across sessions that never close. PreCompact is not a
 * close either, it is the moment context is about to be lost, which is when
 * reconciliation matters most.
 */
export function isSessionClose(event: string): boolean {
  return event === CLAUDE_CODE_EVENTS.sessionEnd;
}

export interface ClaudeVisibleMessage {
  host: "claude-code";
  hostSessionId: string;
  clientInstanceId: string;
  sourceGeneration: number;
  hostMessageId: string;
  role: "user";
  turnOrigin?: TurnOrigin;
  turnOriginEvidence?: string;
  content: string;
}

/**
 * A UserPromptSubmit payload as something the outbox can accept.
 *
 * Claude Code gives a hook no message id, so one is derived from the session and
 * the prompt itself. It must be stable, because a hook can be redelivered and an
 * unstable id would turn one message into two.
 */
export function toVisibleMessage(
  payload: {
    session_id?: string;
    prompt?: string;
    turnOrigin?: TurnOrigin;
    turnOriginEvidence?: string;
  },
  context: { clientInstanceId: string; sourceGeneration?: number; occurrenceIndex?: number }
): ClaudeVisibleMessage | null {
  const hostSessionId = payload?.session_id;
  const prompt = payload?.prompt;
  if (typeof hostSessionId !== "string" || hostSessionId.length === 0) return null;
  if (typeof prompt !== "string" || prompt.length === 0) return null;

  const occurrencePrefix =
    context.occurrenceIndex !== undefined && context.occurrenceIndex > 0
      ? `${hostSessionId} ${context.occurrenceIndex} ${prompt}`
      : `${hostSessionId} ${prompt}`;

  return {
    host: "claude-code",
    hostSessionId,
    clientInstanceId: context.clientInstanceId,
    sourceGeneration: context.sourceGeneration ?? 0,
    hostMessageId: createHash("sha256")
      .update(occurrencePrefix, "utf8")
      .digest("hex")
      .slice(0, 32),
    role: "user",
    ...classifyTurnOrigin("user", prompt, payload),
    content: prompt,
  };
}

interface TranscriptEntry {
  turnOrigin?: TurnOrigin;
  turnOriginEvidence?: string;
  type?: string;
  uuid?: string;
  message?: { role?: string; content?: unknown };
}

function visibleText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: string; text: string } =>
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string"
    )
    .map((block) => block.text)
    .join("");
}

/**
 * Parsed transcript entries as reconciliation's canonical view.
 *
 * Takes entries, never transcript_path. That path arrives from the host in a
 * hook payload, and opening it here would make a hostile value an arbitrary file
 * read inside the user's session.
 */
export function toTranscriptMessages(entries: readonly TranscriptEntry[]): TranscriptMessage[] {
  const result: TranscriptMessage[] = [];
  for (const entry of entries ?? []) {
    const role = entry?.message?.role;
    if (role !== "user" && role !== "assistant") continue;
    if (typeof entry.uuid !== "string" || entry.uuid.length === 0) continue;
    const content = visibleText(entry.message?.content);
    // Tool calls and system noise are machinery, not conversation.
    if (content.length === 0) continue;
    const normalized = normalizeVisibleMessage({ role, content }, { truncate: false });
    result.push({
      hostMessageId: entry.uuid,
      role,
      ...classifyTurnOrigin(role, content, entry),
      content: normalized.content,
      contentHash: normalized.contentHash,
    });
  }
  return result;
}
