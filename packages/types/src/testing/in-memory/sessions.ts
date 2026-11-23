// in-memory/sessions.ts — InMemoryStorageAdapter's Session port methods.
// decompose-inmemory-storage-adapter Batch B3 (design.md Module Map row 4).
// Bodies moved verbatim from InMemoryStorageAdapter.ts — the only edit is
// `this.<field>` → `state.<field>` (design.md D7 move-only rule). Several
// bodies mutate stored objects in place (`recordSessionRecall`,
// `pinSessionTurn`, `replaceSessionScratch`, `closeSession`,
// `archiveSession`) — preserved exactly, not converted to a re-`set` pattern.

import type { CreateSessionInput, ManagedSessionLifecyclePort, SessionStats } from "../../ports.js";
import type { Sensitivity } from "../../common.js";
import { SENSITIVITY_ORDER } from "../../security.js";
import { tallySessionStats, utcDayKeys } from "../../dashboard-aggregates.js";
import type {
  ManagedCollapseRetry,
  ManagedLifecycleQuiesceResult,
  ManagedSessionClaim,
  MnemoSession,
  SessionTurn,
} from "../../session.js";
import { RECOVERABLE_MANAGED_ARCHIVE_REASONS } from "../../session.js";
import type { InMemoryStorageState } from "./state.js";
import { uuid } from "./support.js";

export async function createSession(
  state: InMemoryStorageState,
  input: CreateSessionInput
): Promise<MnemoSession> {
  const fail = (code: string): never => {
    throw Object.assign(new Error(code), { code });
  };
  const predecessor = input.predecessorSessionId
    ? state.sessions.get(input.predecessorSessionId)
    : undefined;
  if (input.predecessorSessionId) {
    if (!predecessor || predecessor.workspaceId !== input.workspaceId) fail("NOT_FOUND");
    if (
      predecessor!.sourceHost ||
      predecessor!.sourceSessionId !== input.sourceSessionId ||
      predecessor!.sourceClientInstanceId !== input.sourceClientInstanceId ||
      predecessor!.metadata.actorId !== input.actorId ||
      (predecessor!.sourceGeneration ?? 0) + 1 !== input.sourceGeneration
    )
      fail("SESSION_BINDING_MISMATCH");
    if (predecessor!.status !== "collapsed" && predecessor!.status !== "archived")
      fail("SESSION_ACTIVE");
  }
  const existing =
    input.sourceSessionId &&
    [...state.sessions.values()].find(
      (s) =>
        s.workspaceId === input.workspaceId &&
        !s.sourceHost &&
        s.sourceSessionId === input.sourceSessionId &&
        s.sourceClientInstanceId === input.sourceClientInstanceId &&
        s.sourceGeneration === input.sourceGeneration
    );
  if (existing) {
    if (
      existing.metadata.actorId !== input.actorId ||
      (existing.predecessorSessionId ?? undefined) !== input.predecessorSessionId
    )
      fail("SESSION_BINDING_MISMATCH");
    return existing;
  }
  const id = uuid();
  const session: MnemoSession = {
    id,
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    status: "active",
    turnCount: 0,
    tokenCount: 0,
    openedAt: new Date(),
    metadata: { ...input.metadata, actorId: input.actorId, actorType: input.actorType },
    label: input.label ?? null,
    trafficOrigin: predecessor?.trafficOrigin ?? input.trafficOrigin ?? "unknown",
    sourceSessionId: input.sourceSessionId,
    sourceClientInstanceId: input.sourceClientInstanceId,
    sourceGeneration: input.sourceGeneration,
    predecessorSessionId: input.predecessorSessionId,
    continuityRootId: predecessor?.continuityRootId ?? predecessor?.id ?? id,
  };
  state.sessions.set(session.id, session);
  return session;
}

export async function appendTurn(
  state: InMemoryStorageState,
  sessionId: string,
  turn: Omit<SessionTurn, "id" | "createdAt">
): Promise<number> {
  const session = state.sessions.get(sessionId);
  if (!session || session.workspaceId !== turn.workspaceId) {
    const error = new Error(`Session ${sessionId} not found.`) as Error & { code?: string };
    error.code = "NOT_FOUND";
    throw error;
  }
  if (turn.sourceMessageId) {
    const root = session.continuityRootId ?? session.id;
    const duplicate = state.turns.find(
      (t) =>
        t.workspaceId === turn.workspaceId &&
        t.sourceMessageId === turn.sourceMessageId &&
        (state.sessions.get(t.sessionId)?.continuityRootId ?? t.sessionId) === root
    );
    if (duplicate) {
      if (duplicate.role !== turn.role || duplicate.content !== turn.content)
        throw Object.assign(new Error("Message identity reused"), {
          code: "SOURCE_MESSAGE_CONFLICT",
        });
      return duplicate.turnIndex;
    }
  }
  if (session.status === "collapsed" || session.status === "archived") {
    const error = new Error(`Session ${sessionId} is terminal.`) as Error & { code?: string };
    error.code = "SESSION_TERMINAL";
    throw error;
  }
  const managed = [...state.harnessSessions.values()].find(
    (candidate) => candidate.id === sessionId && candidate.workspaceId === turn.workspaceId
  );
  if (session.status === "collapse_pending") {
    const closeKind = managed?.closeKind ?? session.closeKind;
    const leaseOwner = managed?.leaseOwner ?? session.collapseLeaseOwner;
    const leaseExpiresAt = managed?.leaseExpiresAt ?? session.collapseLeaseExpiresAt;
    if (closeKind === "provisional" && leaseOwner == null && leaseExpiresAt == null) {
      session.status = "active";
      session.closeKind = null;
      session.closeRequestedAt = null;
      session.closeGraceDeadline = null;
      if (managed) {
        managed.status = "active";
        managed.closeKind = null;
        managed.closeRequestedAt = null;
        managed.closeGraceDeadline = null;
        managed.collapseNextAttemptAt = null;
      }
    } else {
      const error = new Error(`Session ${sessionId} is closed for writes.`) as Error & {
        code?: string;
      };
      error.code = "SESSION_CLOSED";
      throw error;
    }
  }
  const turnIndex =
    Math.max(
      -1,
      ...state.turns
        .filter(
          (candidate) =>
            candidate.sessionId === sessionId && candidate.workspaceId === turn.workspaceId
        )
        .map((candidate) => candidate.turnIndex),
      ...state.harnessTurns
        .filter(
          (candidate) =>
            candidate.sessionId === sessionId && candidate.workspaceId === turn.workspaceId
        )
        .map((candidate) => candidate.turnIndex)
    ) + 1;
  state.turns.push({
    id: uuid(),
    createdAt: new Date(),
    ...turn,
    turnOrigin: turn.turnOrigin ?? (turn.role === "assistant" ? "assistant" : "unknown"),
    turnOriginEvidence: turn.turnOriginEvidence ?? "unclassified",
    turnIndex,
    sessionId,
  } as SessionTurn);
  session.turnCount += 1;
  session.tokenCount += turn.tokenCount ?? 0;
  session.lastActivityAt = new Date();
  if (managed) {
    managed.turnCount = session.turnCount;
    managed.tokenCount = session.tokenCount;
    managed.lastActivityAt = session.lastActivityAt;
  }
  return turnIndex;
}

export async function listTurns(
  state: InMemoryStorageState,
  sessionId: string,
  workspaceId: string
): Promise<SessionTurn[]> {
  const ordinary = state.turns.filter(
    (turn) => turn.sessionId === sessionId && turn.workspaceId === workspaceId
  );
  const managed = state.harnessTurns
    .filter((turn) => turn.sessionId === sessionId && turn.workspaceId === workspaceId)
    .map<SessionTurn>((turn) => ({
      id: `${turn.sessionId}:${turn.sourceMessageId}`,
      workspaceId: turn.workspaceId,
      sessionId: turn.sessionId,
      turnIndex: turn.turnIndex,
      role: turn.role,
      content: turn.content,
      turnOrigin: turn.turnOrigin,
      turnOriginEvidence: turn.turnOriginEvidence,
      pinned: turn.pinned,
      sourceMessageId: turn.sourceMessageId,
      supersedesSourceMessageId: turn.supersedesSourceMessageId ?? undefined,
      contentHash: turn.contentHash,
      tokenCount: turn.tokenCount,
      retractedAt: turn.retractedAt ?? undefined,
      retractionReason: turn.retractionReason ?? undefined,
      ingestionEventId: turn.ingestionEventId,
      createdAt: turn.createdAt,
    }));
  return [...ordinary, ...managed].sort((left, right) => left.turnIndex - right.turnIndex);
}

export async function listManagedCollapseTurns(
  state: InMemoryStorageState,
  sessionId: string,
  workspaceId: string
): Promise<SessionTurn[]> {
  const ordinary = state.turns.filter(
    (turn) =>
      turn.sessionId === sessionId &&
      turn.workspaceId === workspaceId &&
      turn.retractedAt === undefined &&
      (turn.role === "user" || turn.role === "assistant")
  );
  const managed = state.harnessTurns
    .filter(
      (turn) =>
        turn.sessionId === sessionId &&
        turn.workspaceId === workspaceId &&
        !turn.retracted &&
        (turn.role === "user" || turn.role === "assistant")
    )
    .map<SessionTurn>((turn) => ({
      id: `${turn.sessionId}:${turn.sourceMessageId}`,
      workspaceId: turn.workspaceId,
      sessionId: turn.sessionId,
      turnIndex: turn.turnIndex,
      role: turn.role,
      content: turn.content,
      turnOrigin: turn.turnOrigin,
      turnOriginEvidence: turn.turnOriginEvidence,
      sourceMessageId: turn.sourceMessageId,
      supersedesSourceMessageId: turn.supersedesSourceMessageId ?? undefined,
      contentHash: turn.contentHash,
      pinned: turn.pinned,
      tokenCount: turn.tokenCount,
      ingestionEventId: turn.ingestionEventId,
      createdAt: turn.createdAt,
    }));
  return [...ordinary, ...managed].sort((left, right) => left.turnIndex - right.turnIndex);
}

export async function closeSession(
  state: InMemoryStorageState,
  id: string,
  workspaceId: string
): Promise<void> {
  const s = state.sessions.get(id);
  const managed = [...state.harnessSessions.values()].some(
    (candidate) => candidate.id === id && candidate.workspaceId === workspaceId
  );
  if (s && s.workspaceId === workspaceId && !managed) {
    (s as MnemoSession & { status: string }).status = "collapsed";
  }
}

export async function archiveSession(
  state: InMemoryStorageState,
  id: string,
  workspaceId: string,
  reason?: string
): Promise<void> {
  const s = state.sessions.get(id);
  const managed = [...state.harnessSessions.values()].some(
    (candidate) => candidate.id === id && candidate.workspaceId === workspaceId
  );
  if (s && s.workspaceId === workspaceId && !managed) {
    (s as MnemoSession & { status: string }).status = "archived";
    if (reason) s.metadata = { ...(s.metadata ?? {}), archiveReason: reason };
  }
}

export async function getSession(
  state: InMemoryStorageState,
  id: string,
  workspaceId: string
): Promise<MnemoSession | null> {
  const s = state.sessions.get(id);
  if (!s || s.workspaceId !== workspaceId) return null;
  const managed = [...state.harnessSessions.values()].find(
    (candidate) => candidate.id === id && candidate.workspaceId === workspaceId
  );
  if (managed) return toSession(state, id);
  const turnCount = state.turns.filter((t) => t.sessionId === id).length;
  return { ...s, turnCount };
}

export async function listSessions(
  state: InMemoryStorageState,
  workspaceId: string
): Promise<MnemoSession[]> {
  return Array.from(state.sessions.values())
    .filter((session) => session.workspaceId === workspaceId)
    .map((session) =>
      [...state.harnessSessions.values()].some(
        (candidate) => candidate.id === session.id && candidate.workspaceId === workspaceId
      )
        ? toSession(state, session.id)
        : session
    );
}

export async function recordSessionRecall(
  state: InMemoryStorageState,
  sessionId: string,
  workspaceId: string
): Promise<void> {
  const s = state.sessions.get(sessionId);
  if (!s || s.workspaceId !== workspaceId) return;
  s.metadata = { ...s.metadata, lastRecallAt: new Date().toISOString() };
}

export async function recordSessionOutcome(
  state: InMemoryStorageState,
  sessionId: string,
  workspaceId: string,
  rating: "success" | "failure" | "neutral"
): Promise<boolean> {
  const s = state.sessions.get(sessionId);
  if (!s || s.workspaceId !== workspaceId) return false;
  s.outcomeRating = rating;
  return true;
}

export async function pinSessionTurn(
  state: InMemoryStorageState,
  input: {
    sessionId: string;
    workspaceId: string;
    turnId?: string;
    turnIndex?: number;
    pinned: boolean;
  }
): Promise<boolean> {
  const { sessionId, workspaceId, turnId, turnIndex, pinned } = input;
  // `!== undefined` rather than truthiness — turn 0 is a real selector.
  const matches =
    turnId !== undefined
      ? (t: SessionTurn) => t.id === turnId
      : turnIndex !== undefined
        ? (t: SessionTurn) => t.turnIndex === turnIndex
        : null;
  if (matches === null) return false;

  const session = state.sessions.get(sessionId);
  if (!session || session.workspaceId !== workspaceId) return false;
  const managedSession = [...state.harnessSessions.values()].find(
    (candidate) => candidate.id === sessionId && candidate.workspaceId === workspaceId
  );
  if (
    managedSession &&
    !(
      managedSession.status === "active" ||
      (managedSession.status === "collapse_pending" &&
        managedSession.closeKind === "provisional" &&
        managedSession.leaseOwner === null &&
        managedSession.leaseExpiresAt === null)
    )
  ) {
    const error = new Error(`Session ${sessionId} is closed for writes.`) as Error & {
      code?: string;
    };
    error.code = "SESSION_CLOSED";
    throw error;
  }

  const turn = state.turns.find(
    (t) => matches(t) && t.sessionId === sessionId && t.workspaceId === workspaceId
  );
  if (turn) {
    (turn as SessionTurn & { pinned: boolean }).pinned = pinned;
    return true;
  }
  const managedTurn = state.harnessTurns.find(
    (candidate) =>
      candidate.sessionId === sessionId &&
      candidate.workspaceId === workspaceId &&
      (turnId !== undefined
        ? `${candidate.sessionId}:${candidate.sourceMessageId}` === turnId
        : candidate.turnIndex === turnIndex)
  );
  if (!managedTurn) return false;
  managedTurn.pinned = pinned;
  return true;
}

export async function replaceSessionScratch(
  state: InMemoryStorageState,
  input: {
    workspaceId: string;
    sessionId: string;
    scratch: Record<string, unknown>;
  }
): Promise<boolean> {
  const s = state.sessions.get(input.sessionId);
  if (!s || s.workspaceId !== input.workspaceId || s.status !== "active") return false;
  (s as MnemoSession & { scratch: Record<string, unknown> }).scratch = input.scratch;
  s.lastActivityAt = new Date();
  const managed = [...state.harnessSessions.values()].find(
    (candidate) => candidate.id === input.sessionId && candidate.workspaceId === input.workspaceId
  );
  if (managed) managed.lastActivityAt = s.lastActivityAt;
  return true;
}

function toSession(state: InMemoryStorageState, id: string): MnemoSession {
  const managed = [...state.harnessSessions.values()].find((candidate) => candidate.id === id)!;
  const publicSession = state.sessions.get(id)!;
  return {
    ...publicSession,
    status: managed.status,
    turnCount: managed.turnCount,
    tokenCount: managed.tokenCount,
    sourceHost: managed.host,
    sourceSessionId: managed.hostSessionId,
    sourceClientInstanceId: managed.clientInstanceId,
    sourceGeneration: managed.generation,
    predecessorSessionId: managed.predecessorSessionId,
    lastActivityAt: managed.lastActivityAt,
    closeKind: managed.closeKind,
    closeRequestedAt: managed.closeRequestedAt,
    closeGraceDeadline: managed.closeGraceDeadline,
    terminalDigestVersion: managed.terminalDigestVersion,
    terminalMessageSetDigest: managed.terminalMessageSetDigest,
    terminalMaxEnqueueSequence: managed.terminalMaxEnqueueSequence,
    sensitivity: managed.sensitivity,
    originActorId: managed.provenance.actorId,
    originActorType: managed.provenance.actorType,
    originUserId: managed.provenance.userId,
    originSensitivityCeiling: managed.provenance.sensitivityCeiling,
    collapseLeaseOwner: managed.leaseOwner,
    collapseLeaseExpiresAt: managed.leaseExpiresAt,
    collapseAttempts: managed.collapseAttempts,
    collapseNextAttemptAt: managed.collapseNextAttemptAt,
    collapseOperationId: managed.collapseOperationId,
    captureIncomplete: managed.captureIncomplete,
    captureIncompleteReasons: [...managed.captureIncompleteReasons],
    archiveReason: managed.archiveReason,
    archivedAt: managed.archivedAt,
  };
}

export async function claimManagedSessions(
  state: InMemoryStorageState,
  input: Parameters<ManagedSessionLifecyclePort["claimManagedSessions"]>[0]
): Promise<ManagedSessionClaim[]> {
  if (state.harnessControls.get(input.workspaceId) === false) return [];
  const now = new Date();
  const inactive = [...state.harnessSessions.values()]
    .filter(
      (session) =>
        session.workspaceId === input.workspaceId &&
        session.status === "active" &&
        session.lastActivityAt.getTime() <= now.getTime() - input.inactivityMs
    )
    .sort(
      (left, right) =>
        left.lastActivityAt.getTime() - right.lastActivityAt.getTime() ||
        left.id.localeCompare(right.id)
    )
    .slice(0, Math.max(0, input.limit));
  for (const session of inactive) {
    session.status = "collapse_pending";
    session.closeKind = "provisional";
    session.closeRequestedAt = now;
    session.closeGraceDeadline = new Date(now.getTime() + input.provisionalGraceMs);
    session.collapseNextAttemptAt = now;
    state.sessions.get(session.id)!.status = "collapse_pending";
  }
  return [...state.harnessSessions.values()]
    .filter(
      (session) =>
        session.workspaceId === input.workspaceId &&
        session.status === "collapse_pending" &&
        session.closeGraceDeadline !== null &&
        session.closeGraceDeadline <= now &&
        (session.collapseNextAttemptAt === null || session.collapseNextAttemptAt <= now) &&
        (session.leaseOwner === null ||
          (session.leaseExpiresAt !== null && session.leaseExpiresAt <= now))
    )
    .sort((left, right) => {
      const leftDueAt = left.collapseNextAttemptAt ?? left.closeGraceDeadline!;
      const rightDueAt = right.collapseNextAttemptAt ?? right.closeGraceDeadline!;
      return leftDueAt.getTime() - rightDueAt.getTime() || left.id.localeCompare(right.id);
    })
    .slice(0, Math.max(0, input.limit))
    .map((session) => {
      session.leased = true;
      session.leaseOwner = input.leaseOwner;
      session.leaseExpiresAt = new Date(now.getTime() + input.leaseMs);
      return {
        session: toSession(state, session.id),
        leaseOwner: input.leaseOwner,
        leaseExpiresAt: session.leaseExpiresAt,
      };
    });
}

export async function markManagedCollapseRetry(
  state: InMemoryStorageState,
  input: Parameters<ManagedSessionLifecyclePort["markManagedCollapseRetry"]>[0]
): Promise<ManagedCollapseRetry | null> {
  const now = new Date();
  const session = [...state.harnessSessions.values()].find(
    (candidate) =>
      candidate.id === input.sessionId &&
      candidate.workspaceId === input.workspaceId &&
      candidate.status === "collapse_pending" &&
      candidate.leaseOwner === input.leaseOwner &&
      candidate.leaseExpiresAt !== null &&
      candidate.leaseExpiresAt > now
  );
  if (!session) return null;
  const delay = Math.min(
    input.maxRetryMs,
    input.baseRetryMs * 2 ** Math.min(session.collapseAttempts, 30)
  );
  session.collapseAttempts = Math.min(2_147_483_647, session.collapseAttempts + 1);
  session.collapseNextAttemptAt = new Date(now.getTime() + delay);
  session.leased = false;
  session.leaseOwner = null;
  const publicSession = state.sessions.get(session.id)!;
  publicSession.metadata = {
    ...publicSession.metadata,
    managedCollapseLastError: input.error,
  };
  return { attempts: session.collapseAttempts, nextAttemptAt: session.collapseNextAttemptAt };
}

export async function finalizeManagedArchive(
  state: InMemoryStorageState,
  input: Parameters<ManagedSessionLifecyclePort["finalizeManagedArchive"]>[0]
): Promise<boolean> {
  const now = new Date();
  const session = [...state.harnessSessions.values()].find(
    (candidate) =>
      candidate.id === input.sessionId &&
      candidate.workspaceId === input.workspaceId &&
      candidate.status === "collapse_pending" &&
      candidate.leaseOwner === input.leaseOwner &&
      candidate.leaseExpiresAt !== null &&
      candidate.leaseExpiresAt > now
  );
  if (!session) return false;
  if (session.collapseOperationId !== null && session.collapseOperationId !== input.operationId) {
    return false;
  }
  const operationOwner = [...state.harnessSessions.values()].find(
    (candidate) => candidate.collapseOperationId === input.operationId
  );
  if (
    operationOwner &&
    (operationOwner.id !== input.sessionId ||
      operationOwner.workspaceId !== input.workspaceId ||
      operationOwner.generation !== session.generation)
  ) {
    return false;
  }
  session.status = "archived";
  session.archiveReason = input.reason;
  session.archivedAt = now;
  session.collapseOperationId = input.operationId;
  session.leased = false;
  session.leaseOwner = null;
  session.leaseExpiresAt = null;
  session.collapseNextAttemptAt = null;
  state.sessions.get(session.id)!.status = "archived";
  for (const effectKind of ["lifecycle_event", "metrics", "redis_cleanup"] as const) {
    const existing = state.managedCollapseEffects.find(
      (effect) =>
        effect.operationId === input.operationId &&
        effect.effectKind === effectKind &&
        effect.sessionId === input.sessionId
    );
    if (existing) {
      existing.status = "pending";
      existing.attempts = 0;
      existing.nextAttemptAt = null;
      existing.completedAt = null;
      existing.lastError = null;
    } else {
      state.managedCollapseEffects.push({
        workspaceId: input.workspaceId,
        operationId: input.operationId,
        effectKind,
        sessionId: input.sessionId,
        status: "pending",
        attempts: 0,
        nextAttemptAt: null,
        completedAt: null,
        lastError: null,
      });
    }
  }
  return true;
}

export async function releaseExpiredManagedLeases(
  state: InMemoryStorageState,
  input: Parameters<ManagedSessionLifecyclePort["releaseExpiredManagedLeases"]>[0]
): Promise<number> {
  const now = new Date();
  let released = 0;
  for (const session of state.harnessSessions.values()) {
    if (
      session.workspaceId === input.workspaceId &&
      session.status === "collapse_pending" &&
      session.leaseOwner !== null &&
      session.leaseExpiresAt !== null &&
      session.leaseExpiresAt <= now
    ) {
      session.leased = false;
      session.leaseOwner = null;
      released += 1;
    }
  }
  return released;
}

export async function retryLegacyManagedArchive(
  state: InMemoryStorageState,
  input: Parameters<ManagedSessionLifecyclePort["retryLegacyManagedArchive"]>[0]
): Promise<boolean> {
  if (state.harnessControls.get(input.workspaceId) === false) return false;
  const recoverable = new Set<string>(RECOVERABLE_MANAGED_ARCHIVE_REASONS);
  const session = [...state.harnessSessions.values()].find(
    (candidate) =>
      candidate.id === input.sessionId &&
      candidate.workspaceId === input.workspaceId &&
      candidate.status === "archived" &&
      candidate.archiveReason !== null &&
      recoverable.has(candidate.archiveReason)
  );
  if (!session) return false;
  const now = new Date();
  session.status = "collapse_pending";
  session.closeKind = "authoritative";
  session.closeRequestedAt = now;
  session.closeGraceDeadline = now;
  session.collapseNextAttemptAt = now;
  session.archiveReason = null;
  session.archivedAt = null;
  session.leased = false;
  session.leaseOwner = null;
  session.leaseExpiresAt = null;
  state.sessions.get(session.id)!.status = "collapse_pending";
  return true;
}

export async function quiesceManagedLifecycle(
  state: InMemoryStorageState,
  input: Parameters<ManagedSessionLifecyclePort["quiesceManagedLifecycle"]>[0]
): Promise<ManagedLifecycleQuiesceResult> {
  if (state.harnessControls.get(input.workspaceId) !== false) {
    const error = new Error(
      "Harness ingestion must be disabled before lifecycle quiesce"
    ) as Error & {
      code?: string;
    };
    error.code = "INGESTION_ENABLED";
    throw error;
  }
  const now = new Date();
  const pending = [...state.harnessSessions.values()].filter(
    (session) => session.workspaceId === input.workspaceId && session.status === "collapse_pending"
  );
  const liveLeaseCount = pending.filter(
    (session) =>
      session.leaseOwner !== null && session.leaseExpiresAt !== null && session.leaseExpiresAt > now
  ).length;
  let reactivatedCount = 0;
  for (const session of pending) {
    const liveLease =
      session.leaseOwner !== null &&
      session.leaseExpiresAt !== null &&
      session.leaseExpiresAt > now;
    if (liveLease) continue;
    session.status = "active";
    session.closeKind = null;
    session.closeRequestedAt = null;
    session.closeGraceDeadline = null;
    session.collapseNextAttemptAt = null;
    session.leased = false;
    session.leaseOwner = null;
    session.leaseExpiresAt = null;
    state.sessions.get(session.id)!.status = "active";
    reactivatedCount += 1;
  }
  return { pendingCount: liveLeaseCount, liveLeaseCount, reactivatedCount };
}

export async function purgeManagedTurns(
  state: InMemoryStorageState,
  input: Parameters<ManagedSessionLifecyclePort["purgeManagedTurns"]>[0]
): Promise<number> {
  const terminalIds = new Set(
    [...state.harnessSessions.values()]
      .filter(
        (session) =>
          session.workspaceId === input.workspaceId &&
          (session.status === "collapsed" || session.status === "archived") &&
          ((session.collapsedAt ?? session.archivedAt)?.getTime() ?? Number.POSITIVE_INFINITY) <
            input.terminalBefore.getTime()
      )
      .map((session) => session.id)
  );
  const selected = state.harnessTurns
    .filter((turn) => terminalIds.has(turn.sessionId))
    .slice(0, Math.max(0, input.limit));
  const selectedKeys = new Set(selected.map((turn) => `${turn.sessionId}:${turn.sourceMessageId}`));
  state.harnessTurns = state.harnessTurns.filter(
    (turn) => !selectedKeys.has(`${turn.sessionId}:${turn.sourceMessageId}`)
  );
  const remaining = Math.max(0, input.limit - selected.length);
  const ordinaryIds = new Set(
    state.turns
      .filter((turn) => terminalIds.has(turn.sessionId))
      .slice(0, remaining)
      .map((turn) => turn.id)
  );
  state.turns = state.turns.filter((turn) => !ordinaryIds.has(turn.id));
  return selected.length + ordinaryIds.size;
}

export async function getSessionScratch(
  state: InMemoryStorageState,
  input: {
    workspaceId: string;
    sessionId: string;
  }
): Promise<Record<string, unknown> | null> {
  const s = state.sessions.get(input.sessionId);
  if (!s || s.workspaceId !== input.workspaceId) return null;
  return (s as MnemoSession & { scratch?: Record<string, unknown> }).scratch ?? {};
}

/** Mirrors SessionRepository.getSessionStats through the shared tally. */
export async function getSessionStats(
  state: InMemoryStorageState,
  input: { workspaceId: string; days: number; maxSensitivity?: Sensitivity }
): Promise<SessionStats> {
  const keys = new Set(utcDayKeys(input.days));
  const dayOf = (d: Date) => d.toISOString().slice(0, 10);
  const ceiling = SENSITIVITY_ORDER[input.maxSensitivity ?? "restricted"];
  const readable = (s: Sensitivity | undefined) => SENSITIVITY_ORDER[s ?? "internal"] <= ceiling;
  const groups = new Map<
    string,
    { day: string; status: string; n: number; collapsed: number; turns: number }
  >();
  for (const s of state.sessions.values()) {
    // The twin's createSession stamps createdAt; a stored row carries openedAt (started_at).
    const started = s.openedAt ?? (s as unknown as { createdAt: Date }).createdAt;
    const day = dayOf(started);
    if (s.workspaceId !== input.workspaceId || !keys.has(day)) continue;
    const key = `${day}|${s.status}`;
    const g = groups.get(key) ?? { day, status: s.status, n: 0, collapsed: 0, turns: 0 };
    g.n += 1;
    if (s.collapsedAt) g.collapsed += 1;
    g.turns += s.turnCount;
    groups.set(key, g);
  }
  const episodes = [...state.episodes.values()]
    .filter(
      (e) =>
        e.workspaceId === input.workspaceId &&
        !e.isSynthetic &&
        keys.has(dayOf(e.occurredAt)) &&
        readable(e.sensitivity)
    )
    .map((e) => ({
      topics: e.topics,
      facts: e.linkedFactIds.filter((id) => {
        const f = state.facts.get(id);
        return f !== undefined && f.workspaceId === e.workspaceId && readable(f.sensitivity);
      }).length,
    }));
  return tallySessionStats(input.days, [...groups.values()], episodes);
}
