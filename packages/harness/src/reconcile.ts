import type { TurnOrigin } from "./content-origin.js";
import type { HarnessOutboxEvent } from "./outbox.js";
import type { AcknowledgedMessageChunkState, MessageIdentity } from "./state.js";

/**
 * A member of the terminal message set, as the digest sees it.
 *
 * Declared here rather than imported: this package's published types must not
 * depend on @mnemo-ai/types, so the shape is structural and stays compatible with
 * computeTerminalDigestV1 without dragging the dependency into the .d.ts.
 *
 * "M" is a message that exists; "L" is a gap where one used to be.
 */
export interface TerminalMember {
  type: "M" | "L";
  hostMessageId: string;
  role: "user" | "assistant";
  contentHash: string;
}

/**
 * One visible message as a trusted host adapter reports it.
 *
 * Reconciliation never opens a transcript itself. It is handed already-normalized
 * messages by the adapter that knows the host's format, so an attacker-controlled
 * path can never become a file this module reads, and normalization stays in one
 * place instead of being re-derived per host.
 */
export interface TranscriptMessage {
  turnOrigin?: TurnOrigin;
  turnOriginEvidence?: string;
  hostMessageId: string;
  role: "user" | "assistant";
  content: string;
  contentHash: string;
}

export interface PlannedAppend {
  turnOrigin?: TurnOrigin;
  turnOriginEvidence?: string;
  hostMessageId: string;
  role: "user" | "assistant";
  content: string;
  /** Set when this append replaces a copy the server already has. */
  supersedesSourceMessageId?: string;
}

export interface PlannedRetraction {
  hostMessageId: string;
  reason: "superseded" | "branch_removed";
}

export interface PlannedCancellation {
  targetEventId: string;
  reason: "terminal_rebuild";
}

export interface ReconciliationPlan {
  appends: PlannedAppend[];
  retractions: PlannedRetraction[];
  cancellations: PlannedCancellation[];
  /** The conversation as it will stand once this plan is applied. */
  liveSet: TerminalMember[];
  /** Whether a terminal barrier may be built now. */
  terminalReady: boolean;
}

export interface ReconciliationInput {
  sourceGeneration: number;
  transcript: TranscriptMessage[];
  acknowledgedMessages: Record<string, MessageIdentity>;
  acknowledgedMessageChunks?: Record<string, AcknowledgedMessageChunkState>;
  pending: readonly HarnessOutboxEvent[];
  compactedMessageIds?: readonly string[];
  transcriptView?: "complete" | "compacted";
}

function identityKey(sourceGeneration: number, hostMessageId: string): string {
  return `${sourceGeneration}:${hostMessageId}`;
}

/**
 * Work out what the server still needs, from what the host now shows.
 *
 * Pure, and host-independent: the same diff runs for every adapter, and every
 * branch of it is decidable from its arguments alone.
 *
 * The two sources of "already handled" are not interchangeable. An ACKNOWLEDGED
 * message is one the server has and may already have extracted knowledge from, so
 * changing it means superseding it — the old copy has to be retracted explicitly.
 * A PENDING message is one nobody has seen, so a change means cancelling the
 * queued copy: there is nothing on the far side to correct.
 */
export function planReconciliation(input: ReconciliationInput): ReconciliationPlan {
  const {
    sourceGeneration,
    transcript,
    acknowledgedMessages,
    acknowledgedMessageChunks,
    pending,
    compactedMessageIds,
    transcriptView,
  } = input;

  const compactedSet = new Set<string>(compactedMessageIds ?? []);
  const isCompactedMessage = (hostMessageId: string): boolean =>
    transcriptView === "compacted" || compactedSet.has(hostMessageId);

  // A queued append that a queued event.cancel already withdraws is not pending
  // any more. Counting it would cancel it again on every retried Stop or close,
  // and make a revised message look stale forever.
  const cancelledTargets = new Set<string>();
  for (const event of pending) {
    if (event.type === "event.cancel") cancelledTargets.add(event.targetEventId);
  }

  const pendingAppends = new Map<string, Array<HarnessOutboxEvent & { type: "turn.append" }>>();
  for (const event of pending) {
    if (
      event.type === "turn.append" &&
      event.sourceGeneration === sourceGeneration &&
      !cancelledTargets.has(event.eventId)
    ) {
      const list = pendingAppends.get(event.hostMessageId) ?? [];
      list.push(event as HarnessOutboxEvent & { type: "turn.append" });
      pendingAppends.set(event.hostMessageId, list);
    }
  }

  const appends: PlannedAppend[] = [];
  const retractions: PlannedRetraction[] = [];
  const cancellations: PlannedCancellation[] = [];
  const live = new Map<string, TerminalMember>();

  const seen = new Set<string>();
  for (const message of transcript) {
    seen.add(message.hostMessageId);
    live.set(message.hostMessageId, {
      type: "M",
      hostMessageId: message.hostMessageId,
      role: message.role,
      contentHash: message.contentHash,
    });

    const key = identityKey(sourceGeneration, message.hostMessageId);
    const partialAck = acknowledgedMessageChunks?.[key];
    const queuedList = pendingAppends.get(message.hostMessageId);

    if (queuedList && queuedList.length > 0) {
      const firstQueued = queuedList[0]!;
      if (!firstQueued.chunk && queuedList.length === 1 && !partialAck) {
        if (firstQueued.contentHash === message.contentHash) continue;
      } else {
        const expectedChunkCount = firstQueued.chunk?.chunkCount ?? partialAck?.chunkCount ?? 0;
        const expectedMessageHash =
          firstQueued.chunk?.messageContentHash ?? partialAck?.messageContentHash ?? "";
        if (expectedChunkCount >= 2 && expectedMessageHash === message.contentHash) {
          const coveredIndices = new Set<number>();
          let allMatch = true;
          if (partialAck) {
            if (
              partialAck.chunkCount !== expectedChunkCount ||
              partialAck.messageContentHash !== message.contentHash
            ) {
              allMatch = false;
            } else {
              for (const idxStr of Object.keys(partialAck.chunks)) {
                coveredIndices.add(Number(idxStr));
              }
            }
          }
          for (const ev of queuedList) {
            if (
              !ev.chunk ||
              ev.chunk.chunkCount !== expectedChunkCount ||
              ev.chunk.messageContentHash !== message.contentHash
            ) {
              allMatch = false;
              break;
            }
            coveredIndices.add(ev.chunk.chunkIndex);
          }
          if (allMatch && coveredIndices.size === expectedChunkCount) {
            continue;
          }
        }
      }
      // Stale or incomplete: withdraw queued events and re-append the current message.
      for (const ev of queuedList) {
        cancellations.push({ targetEventId: ev.eventId, reason: "terminal_rebuild" });
      }
      appends.push({
        hostMessageId: message.hostMessageId,
        role: message.role,
        content: message.content,
        ...(message.turnOrigin
          ? { turnOrigin: message.turnOrigin, turnOriginEvidence: message.turnOriginEvidence }
          : {}),
      });
      continue;
    }

    const known = acknowledgedMessages[key];
    if (!known) {
      appends.push({
        hostMessageId: message.hostMessageId,
        role: message.role,
        content: message.content,
        ...(message.turnOrigin
          ? { turnOrigin: message.turnOrigin, turnOriginEvidence: message.turnOriginEvidence }
          : {}),
      });
      continue;
    }
    // A loss marker means the content is unrecoverable. Re-appending would invent
    // a message; the gap stays a gap.
    if (known.type === "L") continue;

    if (known.contentHash !== message.contentHash) {
      retractions.push({ hostMessageId: message.hostMessageId, reason: "superseded" });
      appends.push({
        hostMessageId: message.hostMessageId,
        role: message.role,
        content: message.content,
        ...(message.turnOrigin
          ? { turnOrigin: message.turnOrigin, turnOriginEvidence: message.turnOriginEvidence }
          : {}),
        supersedesSourceMessageId: message.hostMessageId,
      });
      continue;
    }
    if (known.retracted) {
      // It came back. The server was told it was gone, so it needs telling again.
      appends.push({
        hostMessageId: message.hostMessageId,
        role: message.role,
        content: message.content,
        ...(message.turnOrigin
          ? { turnOrigin: message.turnOrigin, turnOriginEvidence: message.turnOriginEvidence }
          : {}),
        supersedesSourceMessageId: message.hostMessageId,
      });
    }
  }

  for (const [, known] of Object.entries(acknowledgedMessages)) {
    if (known.sourceGeneration !== sourceGeneration) continue;
    if (seen.has(known.hostMessageId)) continue;

    if (known.type === "L") {
      // The gap is part of the record even though the message is not.
      live.set(known.hostMessageId, {
        type: "L",
        hostMessageId: known.hostMessageId,
        role: known.role,
        contentHash: known.contentHash,
      });
      continue;
    }
    if (known.retracted) continue;
    if (isCompactedMessage(known.hostMessageId)) {
      live.set(known.hostMessageId, {
        type: "M",
        hostMessageId: known.hostMessageId,
        role: known.role,
        contentHash: known.contentHash,
      });
      continue;
    }
    retractions.push({ hostMessageId: known.hostMessageId, reason: "branch_removed" });
  }

  for (const [hostMessageId, queuedList] of pendingAppends) {
    if (seen.has(hostMessageId)) continue;
    if (isCompactedMessage(hostMessageId)) {
      const first = queuedList[0]!;
      const msgHash = first.chunk?.messageContentHash ?? first.contentHash;
      live.set(hostMessageId, {
        type: "M",
        hostMessageId,
        role: first.role,
        contentHash: msgHash,
      });
      continue;
    }
    // Replay may already have committed (with a lost ACK), or will commit before
    // a later cancellation. Follow it with a retraction so either case leaves
    // the same live set. A cancellation only works on a retryable server event.
    if (
      !retractions.some((entry) => entry.hostMessageId === hostMessageId) &&
      !pending.some(
        (entry) =>
          entry.type === "turn.retract" &&
          entry.sourceGeneration === sourceGeneration &&
          entry.hostMessageId === hostMessageId
      )
    )
      retractions.push({ hostMessageId, reason: "branch_removed" });
  }

  const hasPartialAckChunks = Object.values(acknowledgedMessageChunks ?? {}).some(
    (entry) => entry.sourceGeneration === sourceGeneration
  );

  return {
    appends,
    retractions,
    cancellations,
    liveSet: [...live.values()],
    // A barrier asserts "this is the whole conversation". Emitting one while
    // appends, retractions or unsent events are outstanding would have the server
    // verify a digest against a set it does not yet hold.
    terminalReady:
      appends.length === 0 &&
      retractions.length === 0 &&
      cancellations.length === 0 &&
      pending.length === 0 &&
      !hasPartialAckChunks,
  };
}
