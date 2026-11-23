import {
  computeTerminalDigestV1,
  HARNESS_CLOSE_GRACE_MS,
  HARNESS_MAX_GENERATION,
  sha256Hex,
  validateHarnessEventSemantics,
  type HarnessEvent,
  type HarnessEventAck,
  type ManagedSessionProvenance,
} from "../../harness.js";
import { SENSITIVITY_ORDER } from "../../security.js";
import type {
  InMemoryHarnessLedger,
  InMemoryHarnessSession,
  InMemoryStorageState,
} from "./state.js";
import { uuid } from "./support.js";

const locks = new WeakMap<InMemoryStorageState, Map<string, Promise<void>>>();

function logicalSource(workspaceId: string, event: HarnessEvent): string {
  return JSON.stringify([workspaceId, event.host, event.clientInstanceId, event.hostSessionId]);
}

function sessionKey(source: string, generation: number): string {
  return JSON.stringify([source, generation]);
}

function rejection(eventId: string, code: string, retryable: boolean): HarnessEventAck {
  return { eventId, status: "rejected", retryable, code };
}

async function serial<T>(state: InMemoryStorageState, key: string, fn: () => T): Promise<T> {
  let stateLocks = locks.get(state);
  if (!stateLocks) {
    stateLocks = new Map();
    locks.set(state, stateLocks);
  }
  const previous = stateLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  stateLocks.set(key, queued);
  await previous;
  try {
    return fn();
  } finally {
    release();
    if (stateLocks.get(key) === queued) stateLocks.delete(key);
  }
}

function sessionsFor(state: InMemoryStorageState, source: string): InMemoryHarnessSession[] {
  return [...state.harnessSessions.values()]
    .filter((session) => session.logicalSource === source)
    .sort((a, b) => a.generation - b.generation);
}

function makeSession(input: {
  state: InMemoryStorageState;
  workspaceId: string;
  source: string;
  event: HarnessEvent;
  generation: number;
  sensitivity: "public" | "internal";
  provenance: ManagedSessionProvenance;
  receivedAt: Date;
  predecessor?: InMemoryHarnessSession;
}): InMemoryHarnessSession {
  const session: InMemoryHarnessSession = {
    id: uuid(),
    logicalSource: input.source,
    workspaceId: input.workspaceId,
    host: input.event.host,
    clientInstanceId: input.event.clientInstanceId,
    hostSessionId: input.event.hostSessionId,
    generation: input.generation,
    predecessorSessionId: input.predecessor?.id ?? null,
    status: "active",
    closeKind: null,
    terminalDigestVersion: null,
    terminalMaxEnqueueSequence: null,
    terminalMessageSetDigest: null,
    closeGraceDeadline: null,
    closeRequestedAt: null,
    sensitivity: input.sensitivity,
    provenance: { ...input.provenance },
    startSequence: input.event.enqueueSequence,
    turnCount: 0,
    tokenCount: 0,
    lastActivityAt: input.receivedAt,
    captureIncomplete: false,
    captureIncompleteReasons: [],
    leased: false,
    leaseOwner: null,
    leaseExpiresAt: null,
    collapseAttempts: 0,
    collapseNextAttemptAt: null,
    collapseOperationId: null,
    archiveReason: null,
    archivedAt: null,
    collapsedAt: null,
  };
  input.state.harnessSessions.set(sessionKey(input.source, input.generation), session);
  input.state.sessions.set(session.id, {
    trafficOrigin: session.provenance.trafficOrigin ?? "unknown",
    id: session.id,
    workspaceId: input.workspaceId,
    status: "active",
    turnCount: 0,
    tokenCount: 0,
    openedAt: new Date(),
    createdAt: input.receivedAt,
    updatedAt: input.receivedAt,
    metadata: {},
  } as never);
  return session;
}

function successor(
  state: InMemoryStorageState,
  source: string,
  previous: InMemoryHarnessSession,
  event: HarnessEvent,
  receivedAt: Date
): InMemoryHarnessSession | null {
  const existing = state.harnessSessions.get(sessionKey(source, previous.generation + 1));
  if (!existing && previous.generation === HARNESS_MAX_GENERATION) return null;
  return (
    existing ??
    makeSession({
      state,
      workspaceId: previous.workspaceId,
      source,
      event,
      generation: previous.generation + 1,
      sensitivity: previous.sensitivity,
      provenance: previous.provenance,
      receivedAt,
      predecessor: previous,
    })
  );
}

function finalise(
  state: InMemoryStorageState,
  ledger: InMemoryHarnessLedger,
  acknowledgement: HarnessEventAck,
  ledgerState: InMemoryHarnessLedger["state"] = acknowledgement.status === "accepted"
    ? "accepted"
    : "rejected"
): HarnessEventAck {
  ledger.state = ledgerState;
  ledger.acknowledgement = { ...acknowledgement };
  state.harnessLedger.set(`${ledger.workspaceId}:${ledger.eventId}`, ledger);
  return { ...acknowledgement };
}

function duplicate(acknowledgement: HarnessEventAck): HarnessEventAck {
  return { ...acknowledgement };
}

function sameProvenance(left: ManagedSessionProvenance, right: ManagedSessionProvenance): boolean {
  return (
    left.actorId === right.actorId &&
    left.actorType === right.actorType &&
    left.userId === right.userId &&
    left.sensitivityCeiling === right.sensitivityCeiling
  );
}

function sequenceBlockCode(
  state: InMemoryStorageState,
  source: string,
  currentEventId: string,
  enqueueSequence: number,
  exemptEventId?: string
): "lower_sequence_pending" | "source_sequence_gap" | null {
  const rows = [...state.harnessLedger.values()]
    .filter((row) => row.logicalSource === source && row.eventId !== currentEventId)
    .sort((a, b) => a.enqueueSequence - b.enqueueSequence);
  let next = 1;
  for (const row of rows) {
    if (row.enqueueSequence < next) continue;
    if (row.enqueueSequence !== next) break;
    if (row.state === "retryable" && row.eventId !== exemptEventId) break;
    next += 1;
  }
  if (enqueueSequence === next) return null;
  const blocker = rows.find(
    (row) =>
      row.enqueueSequence === next && row.state === "retryable" && row.eventId !== exemptEventId
  );
  return blocker ? "lower_sequence_pending" : "source_sequence_gap";
}

function acceptsMutation(
  session: InMemoryHarnessSession,
  enqueueSequence: number,
  receivedAt: Date
): boolean {
  if (session.status === "active") return true;
  if (session.status !== "collapse_pending" || session.leased || session.leaseExpiresAt !== null) {
    return false;
  }
  if (session.closeKind === "provisional") return true;
  return (
    session.closeKind === "authoritative" &&
    session.closeGraceDeadline !== null &&
    receivedAt <= session.closeGraceDeadline &&
    session.terminalMaxEnqueueSequence !== null &&
    enqueueSequence <= session.terminalMaxEnqueueSequence
  );
}

export async function ingestHarnessEvent(
  state: InMemoryStorageState,
  input: {
    workspaceId: string;
    provenance: ManagedSessionProvenance;
    event: HarnessEvent;
    receivedAt: Date;
  }
): Promise<HarnessEventAck> {
  const semanticError = validateHarnessEventSemantics(input.event, input.receivedAt);
  if (semanticError) return rejection(input.event.eventId, semanticError, false);

  const provenance = { ...input.provenance };
  const source = logicalSource(input.workspaceId, input.event);
  return serial(state, source, () => {
    if (state.harnessControls.get(input.workspaceId) === false) {
      return rejection(input.event.eventId, "ingestion_disabled", true);
    }

    const ledgerKey = `${input.workspaceId}:${input.event.eventId}`;
    const existingLedger = state.harnessLedger.get(ledgerKey);
    if (existingLedger) {
      if (!sameProvenance(existingLedger.provenance, provenance)) {
        return rejection(input.event.eventId, "event_binding_mismatch", false);
      }
      if (existingLedger.payloadHash !== input.event.payloadHash) {
        return rejection(input.event.eventId, "payload_hash_mismatch", false);
      }
      if (existingLedger.state !== "retryable") return duplicate(existingLedger.acknowledgement);
    }

    const sequenceKey = `${source}:${input.event.enqueueSequence}`;
    const sequenceOwner = state.harnessSequenceLedger.get(sequenceKey);
    if (sequenceOwner && sequenceOwner !== input.event.eventId) {
      return rejection(input.event.eventId, "source_sequence_conflict", false);
    }

    const allSessions = sessionsFor(state, source);
    const sourceTurns = state.harnessTurns.filter((turn) =>
      allSessions.some((session) => session.id === turn.sessionId)
    );
    const sourceLosses = state.harnessLosses.filter((loss) =>
      allSessions.some((session) => session.id === loss.sessionId)
    );
    const permanentConflict = (code: string): HarnessEventAck =>
      existingLedger
        ? finalise(state, existingLedger, rejection(input.event.eventId, code, false))
        : rejection(input.event.eventId, code, false);
    if (input.event.type === "turn.append") {
      const appendEvent = input.event;
      if (sourceLosses.some((loss) => loss.sourceMessageId === appendEvent.hostMessageId)) {
        return permanentConflict("loss_identity_conflict");
      }
      const known = sourceTurns.find((turn) => turn.sourceMessageId === appendEvent.hostMessageId);
      if (known?.role !== undefined && known.role !== appendEvent.role) {
        return permanentConflict("source_message_identity_mismatch");
      }
      const expectedContentHash = appendEvent.chunk
        ? appendEvent.chunk.messageContentHash
        : appendEvent.contentHash;
      if (known && known.contentHash !== expectedContentHash) {
        return permanentConflict("content_hash_mismatch");
      }
      if (appendEvent.supersedesSourceMessageId) {
        const predecessor = sourceTurns.find(
          (turn) => turn.sourceMessageId === appendEvent.supersedesSourceMessageId
        );
        if (
          !predecessor ||
          predecessor.sourceMessageId === appendEvent.hostMessageId ||
          predecessor.retracted ||
          predecessor.role !== appendEvent.role
        ) {
          return permanentConflict("missing_superseded_source_message");
        }
      }
    }
    if (input.event.type === "sequence.loss") {
      const lossEvent = input.event;
      const knownTurn = sourceTurns.find(
        (turn) => turn.sourceMessageId === lossEvent.lostHostMessageId
      );
      const knownLoss = state.harnessLosses.find(
        (loss) =>
          allSessions.some((session) => session.id === loss.sessionId) &&
          loss.sourceMessageId === lossEvent.lostHostMessageId
      );
      if (knownLoss || (knownTurn && lossEvent.lostEventType === "turn.append")) {
        return permanentConflict("loss_identity_conflict");
      }
      if (
        knownTurn &&
        (knownTurn.role !== lossEvent.lostRole ||
          knownTurn.contentHash !== lossEvent.lostContentHash)
      ) {
        return permanentConflict("loss_identity_mismatch");
      }
    }

    const ledger: InMemoryHarnessLedger =
      existingLedger ??
      ({
        id: uuid(),
        workspaceId: input.workspaceId,
        eventId: input.event.eventId,
        logicalSource: source,
        enqueueSequence: input.event.enqueueSequence,
        payloadHash: input.event.payloadHash,
        provenance,
        state: "retryable",
        acknowledgement: rejection(input.event.eventId, "pending", true),
      } satisfies InMemoryHarnessLedger);
    state.harnessLedger.set(ledgerKey, ledger);
    state.harnessSequenceLedger.set(sequenceKey, input.event.eventId);

    if (input.event.type === "session.start") {
      const sequenceCode = sequenceBlockCode(
        state,
        source,
        input.event.eventId,
        input.event.enqueueSequence
      );
      if (sequenceCode) {
        ledger.acknowledgement = rejection(input.event.eventId, sequenceCode, true);
        return duplicate(ledger.acknowledgement);
      }
      const requestedSensitivity = input.event.sensitivity ?? "internal";
      if (
        SENSITIVITY_ORDER[requestedSensitivity] > SENSITIVITY_ORDER[provenance.sensitivityCeiling]
      ) {
        return finalise(
          state,
          ledger,
          rejection(input.event.eventId, "sensitivity_ceiling_exceeded", false)
        );
      }
      const latest = allSessions.at(-1);
      if (
        latest &&
        (latest.sensitivity !== requestedSensitivity ||
          latest.provenance.actorId !== provenance.actorId ||
          latest.provenance.actorType !== provenance.actorType ||
          latest.provenance.userId !== provenance.userId ||
          latest.provenance.sensitivityCeiling !== provenance.sensitivityCeiling)
      ) {
        return finalise(
          state,
          ledger,
          rejection(input.event.eventId, "session_binding_mismatch", false)
        );
      }
      let session: InMemoryHarnessSession;
      if (!latest) {
        session = makeSession({
          state,
          workspaceId: input.workspaceId,
          source,
          event: input.event,
          generation: 0,
          sensitivity: requestedSensitivity,
          provenance,
          receivedAt: input.receivedAt,
        });
      } else if (
        input.event.requestedGeneration === latest.generation + 1 &&
        !acceptsMutation(latest, input.event.enqueueSequence, input.receivedAt)
      ) {
        const next = successor(state, source, latest, input.event, input.receivedAt);
        if (!next) {
          return finalise(
            state,
            ledger,
            rejection(input.event.eventId, "generation_exhausted", false)
          );
        }
        session = next;
      } else {
        session = latest;
      }
      return finalise(state, ledger, {
        eventId: input.event.eventId,
        status: "accepted",
        retryable: false,
        sessionId: session.id,
        effectiveGeneration: session.generation,
      });
    }

    if (input.event.type === "event.cancel") {
      const target = state.harnessLedger.get(`${input.workspaceId}:${input.event.targetEventId}`);
      if (!target) {
        ledger.acknowledgement = rejection(
          input.event.eventId,
          "cancel_target_not_retryable",
          true
        );
        return ledger.acknowledgement;
      }
      if (
        target.logicalSource !== source ||
        !sameProvenance(target.provenance, provenance) ||
        target.state !== "retryable" ||
        target.enqueueSequence >= input.event.enqueueSequence
      ) {
        return finalise(
          state,
          ledger,
          rejection(input.event.eventId, "cancel_target_not_retryable", false)
        );
      }
      const targetSequenceCode = sequenceBlockCode(
        state,
        source,
        input.event.eventId,
        input.event.enqueueSequence,
        target.eventId
      );
      if (targetSequenceCode) {
        ledger.acknowledgement = rejection(input.event.eventId, targetSequenceCode, true);
        return ledger.acknowledgement;
      }
      state.harnessMessageChunks = state.harnessMessageChunks.filter(
        (chunk) => !(chunk.workspaceId === input.workspaceId && chunk.ingestionEventId === target.id)
      );
      finalise(state, target, rejection(target.eventId, "event_cancelled", false), "cancelled");
      return finalise(state, ledger, {
        eventId: input.event.eventId,
        status: "accepted",
        retryable: false,
      });
    }

    let session = state.harnessSessions.get(sessionKey(source, input.event.sourceGeneration));
    const latestBeforeRoute = allSessions.at(-1);
    if (
      !session &&
      latestBeforeRoute &&
      input.event.sourceGeneration === latestBeforeRoute.generation + 1 &&
      !acceptsMutation(latestBeforeRoute, input.event.enqueueSequence, input.receivedAt) &&
      sameProvenance(latestBeforeRoute.provenance, provenance)
    ) {
      session = successor(state, source, latestBeforeRoute, input.event, input.receivedAt) ?? undefined;
    }
    if (!session) {
      ledger.acknowledgement = rejection(input.event.eventId, "missing_session_start", true);
      return ledger.acknowledgement;
    }
    if (!sameProvenance(session.provenance, provenance)) {
      return finalise(
        state,
        ledger,
        rejection(input.event.eventId, "session_binding_mismatch", false)
      );
    }
    const sequenceCode =
      input.event.type === "session.end"
        ? null
        : sequenceBlockCode(state, source, input.event.eventId, input.event.enqueueSequence);
    if (sequenceCode) {
      ledger.acknowledgement = rejection(input.event.eventId, sequenceCode, true);
      return duplicate(ledger.acknowledgement);
    }

    if (input.event.type === "turn.append") {
      const appendEvent = input.event;
      const known = state.harnessTurns.find(
        (turn) =>
          allSessions.some((candidate) => candidate.id === turn.sessionId) &&
          turn.sourceMessageId === appendEvent.hostMessageId
      );
      if (known) {
        const knownSession = allSessions.find((candidate) => candidate.id === known.sessionId)!;
        return finalise(state, ledger, {
          eventId: input.event.eventId,
          status: "accepted",
          retryable: false,
          sessionId: known.sessionId,
          effectiveGeneration: knownSession.generation,
        });
      }
      const latest = sessionsFor(state, source).at(-1)!;
      session = latest.generation > session.generation ? latest : session;
      if (session.status !== "active") {
        if (session.status === "collapse_pending" && session.closeKind === "authoritative") {
          const coveredByGrace =
            !session.leased &&
            session.leaseExpiresAt === null &&
            session.closeGraceDeadline !== null &&
            input.receivedAt <= session.closeGraceDeadline &&
            session.terminalMaxEnqueueSequence !== null &&
            appendEvent.enqueueSequence <= session.terminalMaxEnqueueSequence;
          if (!coveredByGrace) {
            const next = successor(
              state,
              source,
              sessionsFor(state, source).at(-1)!,
              input.event,
              input.receivedAt
            );
            if (!next) {
              return finalise(
                state,
                ledger,
                rejection(input.event.eventId, "generation_exhausted", false)
              );
            }
            session = next;
          }
        } else if (
          session.status === "collapse_pending" &&
          session.closeKind === "provisional" &&
          !session.leased &&
          session.leaseExpiresAt === null
        ) {
          session.status = "active";
          session.closeKind = null;
          session.closeRequestedAt = null;
          session.closeGraceDeadline = null;
          session.terminalMaxEnqueueSequence = null;
          session.terminalMessageSetDigest = null;
          (state.sessions.get(session.id) as unknown as { status: string }).status = "active";
        } else {
          const next = successor(
            state,
            source,
            sessionsFor(state, source).at(-1)!,
            input.event,
            input.receivedAt
          );
          if (!next) {
            return finalise(
              state,
              ledger,
              rejection(input.event.eventId, "generation_exhausted", false)
            );
          }
          session = next;
        }
      }
      let finalContent = appendEvent.content;
      let finalContentHash = appendEvent.contentHash;
      if (appendEvent.chunk) {
        const existingChunks = state.harnessMessageChunks
          .filter(
            (chunk) =>
              chunk.logicalSource === source &&
              chunk.sourceGeneration === session!.generation &&
              chunk.sourceMessageId === appendEvent.hostMessageId
          )
          .sort((a, b) => a.chunkIndex - b.chunkIndex);
        for (const row of existingChunks) {
          if (
            row.role !== appendEvent.role ||
            row.chunkCount !== appendEvent.chunk.chunkCount ||
            row.messageContentHash !== appendEvent.chunk.messageContentHash ||
            row.supersedesSourceMessageId !== appendEvent.supersedesSourceMessageId
          ) {
            return finalise(
              state,
              ledger,
              rejection(input.event.eventId, "source_message_identity_mismatch", false)
            );
          }
          if (
            row.chunkIndex === appendEvent.chunk.chunkIndex &&
            row.chunkContentHash !== appendEvent.contentHash
          ) {
            return finalise(
              state,
              ledger,
              rejection(input.event.eventId, "content_hash_mismatch", false)
            );
          }
        }
        const alreadyHasChunk = existingChunks.some(
          (row) => row.chunkIndex === appendEvent.chunk!.chunkIndex
        );
        if (!alreadyHasChunk) {
          state.harnessMessageChunks.push({
            workspaceId: input.workspaceId,
            sessionId: session.id,
            ingestionEventId: ledger.id,
            logicalSource: source,
            sourceGeneration: session.generation,
            sourceMessageId: appendEvent.hostMessageId,
            ...(appendEvent.supersedesSourceMessageId !== undefined
              ? { supersedesSourceMessageId: appendEvent.supersedesSourceMessageId }
              : {}),
            role: appendEvent.role,
            chunkIndex: appendEvent.chunk.chunkIndex,
            chunkCount: appendEvent.chunk.chunkCount,
            chunkContentHash: appendEvent.contentHash,
            messageContentHash: appendEvent.chunk.messageContentHash,
            content: appendEvent.content,
          });
        }
        const allChunks = state.harnessMessageChunks
          .filter(
            (chunk) =>
              chunk.logicalSource === source &&
              chunk.sourceGeneration === session!.generation &&
              chunk.sourceMessageId === appendEvent.hostMessageId
          )
          .sort((a, b) => a.chunkIndex - b.chunkIndex);
        if (allChunks.length < appendEvent.chunk.chunkCount) {
          session.lastActivityAt = new Date(
            Math.max(session.lastActivityAt.getTime(), input.receivedAt.getTime())
          );
          return finalise(state, ledger, {
            eventId: input.event.eventId,
            status: "accepted",
            retryable: false,
            sessionId: session.id,
            effectiveGeneration: session.generation,
          });
        }
        const reassembled = allChunks.map((row) => row.content).join("");
        if (sha256Hex(reassembled) !== appendEvent.chunk.messageContentHash) {
          state.harnessMessageChunks = state.harnessMessageChunks.filter(
            (chunk) =>
              !(
                chunk.logicalSource === source &&
                chunk.sourceGeneration === session!.generation &&
                chunk.sourceMessageId === appendEvent.hostMessageId
              )
          );
          return finalise(
            state,
            ledger,
            rejection(input.event.eventId, "content_hash_mismatch", false)
          );
        }
        state.harnessMessageChunks = state.harnessMessageChunks.filter(
          (chunk) =>
            !(
              chunk.logicalSource === source &&
              chunk.sourceGeneration === session!.generation &&
              chunk.sourceMessageId === appendEvent.hostMessageId
            )
        );
        finalContent = reassembled;
        finalContentHash = appendEvent.chunk.messageContentHash;
      }

      const predecessor = appendEvent.supersedesSourceMessageId
        ? sourceTurns.find((turn) => turn.sourceMessageId === appendEvent.supersedesSourceMessageId)
        : undefined;
      if (predecessor) {
        const predecessorSession = allSessions.find(
          (candidate) => candidate.id === predecessor.sessionId
        )!;
        const predecessorWritable = acceptsMutation(
          predecessorSession,
          appendEvent.enqueueSequence,
          input.receivedAt
        );
        if (predecessorWritable) {
          predecessor.retracted = true;
          predecessor.retractedAt = input.receivedAt;
          predecessor.retractionReason = "superseded";
          session = predecessorSession;
        }
        state.harnessRetractions.push({
          sessionId: session.id,
          workspaceId: input.workspaceId,
          sourceMessageId: predecessor.sourceMessageId,
          predecessorSessionId: predecessorWritable ? null : predecessorSession.id,
          eventId: input.event.eventId,
        });
      }
      const appendSession = session;
      const turnIndex =
        Math.max(
          -1,
          ...state.turns
            .filter((turn) => turn.sessionId === appendSession.id)
            .map((turn) => turn.turnIndex),
          ...state.harnessTurns
            .filter((turn) => turn.sessionId === appendSession.id)
            .map((turn) => turn.turnIndex)
        ) + 1;
      state.harnessTurns.push({
        sessionId: session.id,
        workspaceId: input.workspaceId,
        turnIndex,
        sourceMessageId: appendEvent.hostMessageId,
        supersedesSourceMessageId: appendEvent.supersedesSourceMessageId ?? null,
        role: appendEvent.role,
        content: finalContent,
        turnOrigin:
          appendEvent.turnOrigin ?? (appendEvent.role === "assistant" ? "assistant" : "unknown"),
        turnOriginEvidence: appendEvent.turnOriginEvidence ?? "unclassified",
        contentHash: finalContentHash,
        retracted: false,
        retractedAt: null,
        retractionReason: null,
        pinned: false,
        tokenCount: Math.ceil(Buffer.byteLength(finalContent, "utf8") / 4),
        ingestionEventId: ledger.id,
        createdAt: input.receivedAt,
      });
      session.turnCount += 1;
      session.tokenCount += Math.ceil(Buffer.byteLength(finalContent, "utf8") / 4);
      session.lastActivityAt = new Date(
        Math.max(session.lastActivityAt.getTime(), input.receivedAt.getTime())
      );
      const publicSession = state.sessions.get(session.id) as unknown as Record<string, unknown>;
      publicSession.turnCount = session.turnCount;
      publicSession.tokenCount = session.tokenCount;
      return finalise(state, ledger, {
        eventId: input.event.eventId,
        status: "accepted",
        retryable: false,
        sessionId: session.id,
        effectiveGeneration: session.generation,
      });
    }

    if (input.event.type === "turn.retract") {
      const retractEvent = input.event;
      const targetTurn = state.harnessTurns.find(
        (turn) =>
          turn.workspaceId === input.workspaceId &&
          allSessions.some((candidate) => candidate.id === turn.sessionId) &&
          turn.sourceMessageId === retractEvent.hostMessageId
      );
      if (!targetTurn) {
        ledger.acknowledgement = rejection(input.event.eventId, "missing_source_message", true);
        return ledger.acknowledgement;
      }
      const targetSession = allSessions.find((candidate) => candidate.id === targetTurn.sessionId)!;
      if (acceptsMutation(targetSession, retractEvent.enqueueSequence, input.receivedAt)) {
        targetTurn.retracted = true;
        targetTurn.retractedAt = input.receivedAt;
        targetTurn.retractionReason = retractEvent.reason;
        session = targetSession;
      } else {
        const latest = sessionsFor(state, source).at(-1)!;
        const latestWritable = acceptsMutation(
          latest,
          retractEvent.enqueueSequence,
          input.receivedAt
        );
        if (latestWritable) {
          session = latest;
        } else {
          const next = successor(state, source, latest, input.event, input.receivedAt);
          if (!next) {
            return finalise(
              state,
              ledger,
              rejection(input.event.eventId, "generation_exhausted", false)
            );
          }
          session = next;
        }
      }
      state.harnessRetractions.push({
        sessionId: session.id,
        workspaceId: input.workspaceId,
        sourceMessageId: input.event.hostMessageId,
        predecessorSessionId: session === targetSession ? null : targetSession.id,
        eventId: input.event.eventId,
      });
      return finalise(state, ledger, {
        eventId: input.event.eventId,
        status: "accepted",
        retryable: false,
        sessionId: session.id,
        effectiveGeneration: session.generation,
      });
    }

    if (input.event.type === "sequence.loss") {
      const lossEvent = input.event;
      const acceptsLoss =
        session.status === "active" ||
        (session.status === "collapse_pending" &&
          !session.leased &&
          session.leaseExpiresAt === null &&
          (session.closeKind !== "authoritative" ||
            (session.closeGraceDeadline !== null &&
              input.receivedAt <= session.closeGraceDeadline &&
              session.terminalMaxEnqueueSequence !== null &&
              lossEvent.enqueueSequence <= session.terminalMaxEnqueueSequence)));
      if (!acceptsLoss) {
        ledger.acknowledgement = rejection(input.event.eventId, "generation_changed", true);
        return ledger.acknowledgement;
      }
      const known = state.harnessTurns.find(
        (turn) =>
          turn.sessionId === session.id && turn.sourceMessageId === lossEvent.lostHostMessageId
      );
      if (input.event.lostEventType === "turn.retract" && known) {
        known.retracted = true;
        known.retractedAt = input.receivedAt;
        known.retractionReason = lossEvent.reason;
      }
      state.harnessLosses.push({
        sessionId: session.id,
        workspaceId: input.workspaceId,
        sourceMessageId: input.event.lostHostMessageId,
        role: input.event.lostRole,
        contentHash: input.event.lostContentHash,
        eventId: input.event.eventId,
      });
      session.captureIncomplete = true;
      session.captureIncompleteReasons.push(input.event.reason);
      return finalise(state, ledger, {
        eventId: input.event.eventId,
        status: "accepted",
        retryable: false,
        sessionId: session.id,
        effectiveGeneration: session.generation,
      });
    }

    const terminalEvent = input.event as Extract<HarnessEvent, { type: "session.end" }>;
    if (sessionsFor(state, source).at(-1)?.generation !== terminalEvent.sourceGeneration) {
      ledger.acknowledgement = rejection(terminalEvent.eventId, "generation_changed", true);
      return ledger.acknowledgement;
    }
    if (session.status === "collapse_pending" && session.closeKind === "authoritative") {
      if (
        session.terminalMessageSetDigest === terminalEvent.finalMessageSetDigest &&
        session.terminalMaxEnqueueSequence === terminalEvent.maxEnqueueSequence
      ) {
        return finalise(state, ledger, {
          eventId: terminalEvent.eventId,
          status: "accepted",
          retryable: false,
          sessionId: session.id,
          effectiveGeneration: session.generation,
        });
      }
      return finalise(
        state,
        ledger,
        rejection(terminalEvent.eventId, "terminal_barrier_conflict", false)
      );
    }
    if (session.status === "collapsed" || session.status === "archived") {
      return finalise(
        state,
        ledger,
        rejection(terminalEvent.eventId, "terminal_state_conflict", false)
      );
    }
    if (
      session.status === "collapse_pending" &&
      (session.leased || session.leaseExpiresAt !== null)
    ) {
      return finalise(
        state,
        ledger,
        rejection(terminalEvent.eventId, "terminal_state_conflict", false)
      );
    }
    const lower = [...state.harnessLedger.values()].filter(
      (row) =>
        row.logicalSource === source &&
        row.enqueueSequence >= 1 &&
        row.enqueueSequence <= terminalEvent.maxEnqueueSequence
    );
    const expectedCount = terminalEvent.maxEnqueueSequence;
    const hasPendingChunks = state.harnessMessageChunks.some(
      (chunk) => chunk.workspaceId === input.workspaceId && chunk.sessionId === session!.id
    );
    const complete =
      !hasPendingChunks &&
      lower.length === expectedCount &&
      lower.every((row) => row.state !== "retryable");
    const members = [
      ...state.harnessTurns
        .filter((turn) => turn.sessionId === session!.id && !turn.retracted)
        .map((turn) => ({
          type: "M" as const,
          hostMessageId: turn.sourceMessageId,
          role: turn.role,
          contentHash: turn.contentHash,
        })),
      ...state.harnessLosses
        .filter((loss) => loss.sessionId === session!.id)
        .map((loss) => ({
          type: "L" as const,
          hostMessageId: loss.sourceMessageId,
          role: loss.role as "user" | "assistant",
          contentHash: loss.contentHash,
        })),
    ];
    let digest: string;
    try {
      digest = computeTerminalDigestV1(members);
    } catch {
      return finalise(
        state,
        ledger,
        rejection(input.event.eventId, "terminal_members_conflict", false)
      );
    }
    if (!complete || digest !== terminalEvent.finalMessageSetDigest) {
      ledger.acknowledgement = rejection(input.event.eventId, "incomplete_terminal_barrier", true);
      return ledger.acknowledgement;
    }
    session.status = "collapse_pending";
    session.closeKind = "authoritative";
    session.closeRequestedAt = input.receivedAt;
    session.terminalDigestVersion = 1;
    session.terminalMaxEnqueueSequence = terminalEvent.maxEnqueueSequence;
    session.terminalMessageSetDigest = terminalEvent.finalMessageSetDigest;
    session.closeGraceDeadline = new Date(input.receivedAt.getTime() + HARNESS_CLOSE_GRACE_MS);
    (state.sessions.get(session.id) as unknown as { status: string }).status = "collapse_pending";
    return finalise(state, ledger, {
      eventId: input.event.eventId,
      status: "accepted",
      retryable: false,
      sessionId: session.id,
      effectiveGeneration: session.generation,
    });
  });
}

export function inspectHarnessState(state: InMemoryStorageState, workspaceId: string) {
  return {
    sessions: [...state.harnessSessions.values()]
      .filter((session) => session.workspaceId === workspaceId)
      .map((session) => ({
        id: session.id,
        clientInstanceId: session.clientInstanceId,
        generation: session.generation,
        status: session.status,
        closeKind: session.closeKind,
        turnCount: session.turnCount,
        tokenCount: session.tokenCount,
        lastActivityAt: session.lastActivityAt,
        closeGraceDeadline: session.closeGraceDeadline,
        sensitivity: session.sensitivity,
        captureIncomplete: session.captureIncomplete,
        predecessorSessionId: session.predecessorSessionId,
        terminalMessageSetDigest: session.terminalMessageSetDigest,
        terminalDigestVersion: session.terminalDigestVersion,
        terminalMaxEnqueueSequence: session.terminalMaxEnqueueSequence,
        leased: session.leased,
      })),
    turns: state.harnessTurns
      .filter((turn) => turn.workspaceId === workspaceId)
      .map((turn) => ({ ...turn })),
    ledger: [...state.harnessLedger.values()]
      .filter((row) => row.workspaceId === workspaceId)
      .map((row) => ({
        eventId: row.eventId,
        state: row.state,
        payloadHash: row.payloadHash,
        actorId: row.provenance.actorId,
        actorType: row.provenance.actorType,
        userId: row.provenance.userId,
        sensitivityCeiling: row.provenance.sensitivityCeiling,
        acknowledgement: row.acknowledgement,
      })),
    losses: state.harnessLosses
      .filter((loss) => loss.workspaceId === workspaceId)
      .map((loss) => ({ ...loss })),
    retractions: state.harnessRetractions
      .filter((retraction) => retraction.workspaceId === workspaceId)
      .map((retraction) => ({ ...retraction })),
  };
}

export function setHarnessSessionLifecycle(
  state: InMemoryStorageState,
  workspaceId: string,
  input: {
    generation: number;
    status: "active" | "collapse_pending" | "collapsed" | "archived";
    leased?: boolean;
    closeKind?: "authoritative" | "provisional" | null;
    closeGraceDeadline?: Date | null;
    terminalMaxEnqueueSequence?: number | null;
    terminalMessageSetDigest?: string | null;
  }
): void {
  const session = [...state.harnessSessions.values()].find(
    (candidate) =>
      candidate.workspaceId === workspaceId && candidate.generation === input.generation
  );
  if (!session) throw new Error(`Harness generation ${input.generation} not found`);
  session.status = input.status;
  session.leased = input.leased ?? false;
  session.leaseOwner = session.leased ? "contract-worker" : null;
  session.leaseExpiresAt = session.leased ? new Date("2099-01-01T00:00:00.000Z") : null;
  session.collapsedAt = input.status === "collapsed" ? new Date() : null;
  if (input.closeKind !== undefined) session.closeKind = input.closeKind;
  if (input.closeGraceDeadline !== undefined) {
    session.closeGraceDeadline = input.closeGraceDeadline;
  }
  if (input.terminalMaxEnqueueSequence !== undefined) {
    session.terminalMaxEnqueueSequence = input.terminalMaxEnqueueSequence;
  }
  if (input.terminalMessageSetDigest !== undefined) {
    session.terminalMessageSetDigest = input.terminalMessageSetDigest;
  }
  Object.assign(state.sessions.get(session.id)!, {
    status: input.status,
    closeKind: session.closeKind,
    closeGraceDeadline: session.closeGraceDeadline,
    collapseLeaseOwner: session.leaseOwner,
    collapseLeaseExpiresAt: session.leaseExpiresAt,
    collapsedAt: session.collapsedAt,
  });
}

export function seedHarnessManagedTurn(
  state: InMemoryStorageState,
  workspaceId: string,
  input: {
    generation: number;
    sourceMessageId: string;
    role: "user" | "assistant";
    content: string;
    contentHash: string;
  }
): void {
  const session = [...state.harnessSessions.values()].find(
    (candidate) =>
      candidate.workspaceId === workspaceId && candidate.generation === input.generation
  );
  if (!session) throw new Error(`Harness generation ${input.generation} not found`);
  const turnIndex =
    Math.max(
      -1,
      ...state.turns.filter((turn) => turn.sessionId === session.id).map((turn) => turn.turnIndex),
      ...state.harnessTurns
        .filter((turn) => turn.sessionId === session.id)
        .map((turn) => turn.turnIndex)
    ) + 1;
  state.harnessTurns.push({
    sessionId: session.id,
    workspaceId,
    turnIndex,
    sourceMessageId: input.sourceMessageId,
    supersedesSourceMessageId: null,
    role: input.role,
    content: input.content,
    contentHash: input.contentHash,
    retracted: false,
    retractedAt: null,
    retractionReason: null,
    pinned: false,
    tokenCount: Math.ceil(Buffer.byteLength(input.content, "utf8") / 4),
    ingestionEventId: uuid(),
    createdAt: new Date(),
  });
}
