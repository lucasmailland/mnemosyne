import { createHash } from "node:crypto";
import { normalizeVisibleMessage } from "../sanitize.js";
import type { TranscriptMessage } from "../reconcile.js";

/**
 * OpenCode payload translation. Nothing else.
 *
 * This module maps native shapes to the canonical ones and stops. No outbox, no
 * HTTP, no filesystem: plugin code runs inside someone's editor, so the blast
 * radius of a bug here has to be a wrong mapping, never a wedged host or a
 * leaked credential.
 *
 * Every channel and event name below is pinned by a contract test against a
 * fixture recorded from a real installation. Other projects have subscribed to
 * event names that did not exist and captured nothing for months; the pin is what
 * turns that into a CI failure instead of silence.
 */

export const OPENCODE_CHANNELS = {
  /** Mutating `output.system` reaches the model every turn, and survives compaction. */
  systemPrompt: "experimental.chat.system.transform",
  compaction: "experimental.session.compacting",
  userMessage: "chat.message",
} as const;

export const OPENCODE_SESSION_EVENTS = {
  /** OpenCode has no true session end; idle plus a debounce is the practical close. */
  idle: "session.idle",
  deleted: "session.deleted",
  compacted: "session.compacted",
} as const;

interface NativePart {
  type?: string;
  text?: string;
}

interface NativeMessage {
  id?: string;
  role?: string;
  parts?: NativePart[];
}

/** Visible text only: a tool call or an attachment is machinery, not conversation. */
function visibleText(parts: NativePart[] | undefined): string {
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("");
}

export interface VisibleMessageInput {
  host: "opencode";
  hostSessionId: string;
  clientInstanceId: string;
  sourceGeneration: number;
  hostMessageId: string;
  role: "user" | "assistant";
  content: string;
}

/**
 * A `chat.message` payload as something the outbox can accept.
 *
 * Returns null rather than a partial event when the payload cannot be identified:
 * an event without a stable host id cannot be deduplicated, reconciled or
 * retracted, so enqueuing one would corrupt the very state it joins.
 */
export function toVisibleMessage(
  native: { sessionID?: string; message?: NativeMessage; parts?: NativePart[] },
  context: { clientInstanceId: string; sourceGeneration?: number }
): VisibleMessageInput | null {
  const hostSessionId = native?.sessionID;
  const message = native?.message;
  const role = message?.role;
  if (typeof hostSessionId !== "string" || hostSessionId.length === 0) return null;
  if (typeof message?.id !== "string" || message.id.length === 0) return null;
  if (role !== "user" && role !== "assistant") return null;

  const content = visibleText(native.parts ?? message.parts);
  if (content.length === 0) return null;

  return {
    host: "opencode",
    hostSessionId,
    clientInstanceId: context.clientInstanceId,
    sourceGeneration: context.sourceGeneration ?? 0,
    hostMessageId: message.id,
    role,
    content,
  };
}

/**
 * A native transcript as reconciliation's canonical view.
 *
 * Takes already-loaded messages, never a path. Reconciliation must not be the
 * thing that decides which file to open, or a hostile transcript location becomes
 * an arbitrary file read inside the user's editor.
 */
export function toTranscriptMessages(messages: readonly NativeMessage[]): TranscriptMessage[] {
  const result: TranscriptMessage[] = [];
  for (const message of messages ?? []) {
    const role = message?.role;
    if (role !== "user" && role !== "assistant") continue;
    if (typeof message.id !== "string" || message.id.length === 0) continue;
    const content = visibleText(message.parts);
    if (content.length === 0) continue;
    const normalized = normalizeVisibleMessage({ role, content }, { truncate: false });
    result.push({
      hostMessageId: message.id,
      role,
      content: normalized.content,
      contentHash: normalized.contentHash,
    });
  }
  return result;
}

/**
 * The managed marker, in the form the injected protocol documents:
 *
 *   mnemo-managed-v1:<host>:<clientInstanceId>:<hostSessionId>:<generation>
 *
 * It lands in the model's context to say "this session is already captured, do
 * not open a second episode for it". That makes it something a model has an
 * incentive to forge: suppressing episode bookkeeping is exactly how it would
 * hide what it did.
 *
 * What makes forgery fail is that a valid marker names a generation the LOCAL
 * acknowledgement state has actually mapped — which only happens after the
 * server has acknowledged an event from this session. A model can guess the
 * shape and it can guess `0`; it cannot make the local queue have been
 * acknowledged. Before the first acknowledgement there is no valid marker at
 * all, which is precisely when a forged one would do the most damage.
 */
const MARKER_PREFIX = "mnemo-managed-v1";

export interface ManagedMarkerIdentity {
  host: string;
  clientInstanceId: string;
  hostSessionId: string;
  sourceGeneration: number;
}

interface MarkerState {
  acknowledgedWatermark: number;
  generationMappings: Record<string, number>;
}

export function buildManagedMarker(input: ManagedMarkerIdentity): string {
  return [
    MARKER_PREFIX,
    input.host,
    input.clientInstanceId,
    input.hostSessionId,
    String(input.sourceGeneration),
  ].join(":");
}

/**
 * Accept a marker only if this queue really is managing that session.
 *
 * Identity must match exactly, and the generation must appear in the local
 * generation mapping. Anything else — a marker for another session, another
 * client, a generation nothing has acknowledged, or a hand-typed lookalike — is
 * rejected, and the agent falls back to the ordinary episode lifecycle.
 */
export function validateManagedMarker(
  marker: unknown,
  input: { identity: ManagedMarkerIdentity; state: MarkerState }
): boolean {
  if (typeof marker !== "string") return false;
  if (marker.trim() !== buildManagedMarker(input.identity)) return false;
  const mapped = input.state?.generationMappings?.[String(input.identity.sourceGeneration)];
  return typeof mapped === "number";
}
