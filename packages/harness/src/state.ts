import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  HARNESS_CHUNK_VERSION,
  HARNESS_MAX_CHUNKS_PER_MESSAGE,
  HARNESS_MAX_ENQUEUE_SEQUENCE,
  HARNESS_MAX_GENERATION,
  HARNESS_MAX_IDENTITY_BYTES,
  canonicalJson,
} from "@mnemo-ai/types/harness-runtime";

export interface HarnessTurnAppendChunk {
  version: 1;
  chunkIndex: number;
  chunkCount: number;
  messageContentHash: string;
}
import {
  atomicWritePrivateFile,
  ensureSecureHarnessPaths,
  listSecureRegularFiles,
  readPrivateFile,
  recoverAtomicTemporaryFiles,
  sessionLockName,
  withAdvisoryLock,
  writeFidelityFailureLatch,
  type AtomicWriteOptions,
  type HarnessPaths,
} from "./fs-security.js";

export interface StateOptions extends AtomicWriteOptions {
  home?: string;
}

interface AcknowledgedEventBase {
  eventId: string;
  enqueueSequence: number;
}

export type AcknowledgedEvent =
  | (AcknowledgedEventBase & {
      type: "turn.append";
      sourceGeneration: number;
      hostMessageId: string;
      role: "user" | "assistant";
      contentHash: string;
      chunk?: HarnessTurnAppendChunk;
    })
  | (AcknowledgedEventBase & {
      type: "turn.retract";
      sourceGeneration: number;
      hostMessageId: string;
      reason: "superseded" | "branch_removed";
    })
  | (AcknowledgedEventBase & {
      type: "sequence.loss";
      sourceGeneration: number;
      reason: "capacity" | "invalid_payload" | "permanent_rejection";
      lostEventType: "turn.append" | "turn.retract";
      lostHostMessageId: string;
      lostRole: "user" | "assistant";
      lostContentHash: string;
    })
  | (AcknowledgedEventBase & {
      type: "session.start";
      requestedGeneration?: number;
      sensitivity?: "public" | "internal";
      metadata?: Record<string, string>;
    })
  | (AcknowledgedEventBase & {
      type: "event.cancel";
      sourceGeneration: number;
      targetEventId: string;
      reason: "generation_redirect" | "terminal_rebuild";
    })
  | (AcknowledgedEventBase & {
      type: "session.end";
      sourceGeneration: number;
      reason: "host_end" | "host_delete" | "inactivity";
      finalMessageSetDigest: string;
      maxEnqueueSequence: number;
    });

export interface MessageIdentity {
  type: "M" | "L";
  sourceGeneration: number;
  hostMessageId: string;
  role: "user" | "assistant";
  contentHash: string;
  retracted: boolean;
  lossReason?: "capacity" | "invalid_payload" | "permanent_rejection";
  lostEventType?: "turn.append" | "turn.retract";
  retractionReason?: "superseded" | "branch_removed";
}

export interface AcknowledgedMessageChunkState {
  sourceGeneration: number;
  hostMessageId: string;
  role: "user" | "assistant";
  chunkCount: number;
  messageContentHash: string;
  chunks: Record<string, string>;
}

export interface SessionState {
  version: 1;
  acknowledgedWatermark: number;
  compactedAcknowledgementWatermark: number;
  lastEnqueuedSequence: number;
  acknowledgedEvents: Record<
    string,
    {
      enqueueSequence: number;
      sourceGeneration?: number;
      effectiveGeneration?: number;
      type: AcknowledgedEvent["type"];
      acknowledgementHash: string;
      terminalDigest?: string;
      acknowledgedAt?: string;
      retainUntil?: string;
    }
  >;
  acknowledgedMessages: Record<string, MessageIdentity>;
  acknowledgedMessageChunks?: Record<string, AcknowledgedMessageChunkState>;
  messageTombstones: Record<string, MessageIdentity>;
  sequenceTombstones: Record<string, string>;
  compactedTerminalAcknowledgementHashes: Record<string, string>;
  enqueuedAcknowledgementHashes: Record<string, string>;
  pendingSequenceReplacements: Record<
    string,
    { previousAcknowledgementHash: string; replacementAcknowledgementHash: string }
  >;
  generationMappings: Record<string, number>;
  terminalDigests: Record<string, string>;
}

export interface SessionStateResult extends SessionState {
  path: string;
}

function emptyState(): SessionState {
  return {
    version: 1,
    acknowledgedWatermark: 0,
    compactedAcknowledgementWatermark: 0,
    lastEnqueuedSequence: 0,
    acknowledgedEvents: {},
    acknowledgedMessages: {},
    messageTombstones: {},
    sequenceTombstones: {},
    compactedTerminalAcknowledgementHashes: {},
    enqueuedAcknowledgementHashes: {},
    pendingSequenceReplacements: {},
    generationMappings: {},
    terminalDigests: {},
  };
}

export function sourceSessionKey(
  host: string,
  clientInstanceId: string,
  hostSessionId: string
): string {
  validateIdentity("host", host);
  validateIdentity("clientInstanceId", clientInstanceId);
  validateIdentity("hostSessionId", hostSessionId);
  return createHash("sha256")
    .update(canonicalJson([host, clientInstanceId, hostSessionId]))
    .digest("hex");
}

function statePath(paths: HarnessPaths, key: string): string {
  return join(paths.state, `${key}.json`);
}

async function recoverStateTemporaryFile(
  paths: HarnessPaths,
  key: string,
  options: AtomicWriteOptions = {}
): Promise<void> {
  const recovery = await recoverAtomicTemporaryFiles([paths.state], new Set([`${key}.json`]), {
    ...options,
    beforeDiscard: () => writeFidelityFailureLatch(paths, "uncommitted_temporary_file", options),
  });
  if (recovery.discarded > 0)
    await writeFidelityFailureLatch(paths, "uncommitted_temporary_file", options);
}

async function readStateAt(path: string): Promise<SessionState> {
  try {
    const parsed = JSON.parse(await readPrivateFile(path)) as SessionState;
    parsed.compactedAcknowledgementWatermark ??= 0;
    parsed.compactedTerminalAcknowledgementHashes ??= {};
    parsed.enqueuedAcknowledgementHashes ??= {};
    parsed.pendingSequenceReplacements ??= {};
    validateState(parsed);
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
    throw error;
  }
}

const HASH_PATTERN = /^[0-9a-f]{64}$/;

function validateIdentity(name: string, value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > HARNESS_MAX_IDENTITY_BYTES
  ) {
    throw new TypeError(`${name} must be a bounded non-empty identity`);
  }
}

function validateGeneration(value: unknown): asserts value is number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > HARNESS_MAX_GENERATION
  )
    throw new TypeError("Invalid source generation");
}

function validateSequence(value: unknown, allowZero = false): asserts value is number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < (allowZero ? 0 : 1) ||
    (value as number) > HARNESS_MAX_ENQUEUE_SEQUENCE
  ) {
    throw new TypeError("Invalid enqueue sequence");
  }
}

function validateState(state: SessionState): void {
  if (state === null || typeof state !== "object" || state.version !== 1)
    throw new Error("Unsupported harness state version");
  validateSequence(state.acknowledgedWatermark, true);
  validateSequence(state.compactedAcknowledgementWatermark, true);
  validateSequence(state.lastEnqueuedSequence, true);
  if (state.acknowledgedWatermark > state.lastEnqueuedSequence)
    throw new Error("Acknowledged watermark exceeds enqueued sequence");
  if (state.compactedAcknowledgementWatermark > state.acknowledgedWatermark)
    throw new Error("Compacted watermark exceeds acknowledged watermark");
  const acknowledgedSequences = new Set<number>();
  for (const [eventId, event] of Object.entries(state.acknowledgedEvents ?? {})) {
    validateIdentity("eventId", eventId);
    validateSequence(event.enqueueSequence);
    if (event.sourceGeneration !== undefined) validateGeneration(event.sourceGeneration);
    if (event.effectiveGeneration !== undefined) validateGeneration(event.effectiveGeneration);
    if (event.type === "session.end" && !HASH_PATTERN.test(event.terminalDigest ?? ""))
      throw new Error("Invalid acknowledged terminal digest");
    if (event.acknowledgedAt !== undefined && !Number.isFinite(Date.parse(event.acknowledgedAt)))
      throw new Error("Invalid acknowledgement timestamp");
    if (event.retainUntil !== undefined && !Number.isFinite(Date.parse(event.retainUntil)))
      throw new Error("Invalid terminal retention deadline");
    if (!HASH_PATTERN.test(event.acknowledgementHash))
      throw new Error("Invalid acknowledgement hash");
    if (event.enqueueSequence > state.lastEnqueuedSequence)
      throw new Error("Acknowledged sequence was not enqueued");
    if (acknowledgedSequences.has(event.enqueueSequence))
      throw new Error("Duplicate acknowledged sequence owner");
    acknowledgedSequences.add(event.enqueueSequence);
  }
  for (const [key, message] of Object.entries({
    ...(state.acknowledgedMessages ?? {}),
    ...(state.messageTombstones ?? {}),
  })) {
    validateGeneration(message.sourceGeneration);
    validateIdentity("hostMessageId", message.hostMessageId);
    if (key !== messageKey(message.sourceGeneration, message.hostMessageId))
      throw new Error("Message state key does not match generation-qualified identity");
    if (!HASH_PATTERN.test(message.contentHash)) throw new Error("Invalid message content hash");
    if ((message.type !== "M" && message.type !== "L") || typeof message.retracted !== "boolean")
      throw new Error("Invalid terminal member state");
  }
  for (const [requested, effective] of Object.entries(state.generationMappings ?? {})) {
    validateGeneration(Number(requested));
    validateGeneration(effective);
  }
  for (const [generation, digest] of Object.entries(state.terminalDigests ?? {})) {
    validateGeneration(Number(generation));
    if (!HASH_PATTERN.test(digest)) throw new Error("Invalid terminal digest");
  }
  for (const [sequence, acknowledgementHash] of Object.entries(state.sequenceTombstones ?? {})) {
    validateSequence(Number(sequence));
    if (!HASH_PATTERN.test(acknowledgementHash))
      throw new Error("Invalid compacted sequence tombstone");
  }
  for (const [generation, acknowledgementHash] of Object.entries(
    state.compactedTerminalAcknowledgementHashes ?? {}
  )) {
    validateGeneration(Number(generation));
    if (!HASH_PATTERN.test(acknowledgementHash))
      throw new Error("Invalid compacted terminal acknowledgement hash");
  }
  if (
    state.enqueuedAcknowledgementHashes === null ||
    typeof state.enqueuedAcknowledgementHashes !== "object" ||
    Array.isArray(state.enqueuedAcknowledgementHashes)
  )
    throw new Error("Invalid enqueued event identities");
  for (const [sequence, acknowledgementHash] of Object.entries(
    state.enqueuedAcknowledgementHashes
  )) {
    validateSequence(Number(sequence));
    if (!HASH_PATTERN.test(acknowledgementHash)) throw new Error("Invalid enqueued event identity");
  }
  for (const [sequence, replacement] of Object.entries(state.pendingSequenceReplacements ?? {})) {
    validateSequence(Number(sequence));
    if (
      !HASH_PATTERN.test(replacement.previousAcknowledgementHash) ||
      !HASH_PATTERN.test(replacement.replacementAcknowledgementHash)
    )
      throw new Error("Invalid pending sequence replacement");
  }
}

function messageKey(sourceGeneration: number, hostMessageId: string): string {
  return `${sourceGeneration}:${hostMessageId}`;
}

function validateAcknowledgement(event: AcknowledgedEvent): void {
  validateIdentity("eventId", event.eventId);
  validateSequence(event.enqueueSequence);
  if (
    !new Set([
      "session.start",
      "turn.append",
      "turn.retract",
      "sequence.loss",
      "event.cancel",
      "session.end",
    ]).has(event.type)
  )
    throw new TypeError("Invalid acknowledgement event type");
  if (event.type === "turn.append" || event.type === "turn.retract")
    validateIdentity("hostMessageId", event.hostMessageId);
  if (event.type !== "session.start") validateGeneration(event.sourceGeneration);
  if (event.type === "turn.append") {
    if (event.role !== "user" && event.role !== "assistant") throw new TypeError("Invalid role");
    if (!HASH_PATTERN.test(event.contentHash)) throw new TypeError("Invalid content hash");
    if (event.chunk !== undefined) {
      if (
        event.chunk === null ||
        typeof event.chunk !== "object" ||
        event.chunk.version !== HARNESS_CHUNK_VERSION ||
        !Number.isSafeInteger(event.chunk.chunkCount) ||
        event.chunk.chunkCount < 2 ||
        event.chunk.chunkCount > HARNESS_MAX_CHUNKS_PER_MESSAGE ||
        !Number.isSafeInteger(event.chunk.chunkIndex) ||
        event.chunk.chunkIndex < 0 ||
        event.chunk.chunkIndex >= event.chunk.chunkCount ||
        !HASH_PATTERN.test(event.chunk.messageContentHash)
      ) {
        throw new TypeError("Invalid turn.append chunk descriptor");
      }
    }
  }
  if (
    event.type === "turn.retract" &&
    event.reason !== "superseded" &&
    event.reason !== "branch_removed"
  )
    throw new TypeError("Invalid retraction reason");
  if (event.type === "sequence.loss") {
    validateIdentity("lostHostMessageId", event.lostHostMessageId);
    if (!new Set(["capacity", "invalid_payload", "permanent_rejection"]).has(event.reason))
      throw new TypeError("Invalid loss reason");
    if (event.lostEventType !== "turn.append" && event.lostEventType !== "turn.retract")
      throw new TypeError("Invalid lost event type");
    if (event.lostRole !== "user" && event.lostRole !== "assistant")
      throw new TypeError("Invalid lost role");
    if (!HASH_PATTERN.test(event.lostContentHash)) throw new TypeError("Invalid lost content hash");
  } else if (event.type === "event.cancel") {
    validateIdentity("targetEventId", event.targetEventId);
    if (event.reason !== "generation_redirect" && event.reason !== "terminal_rebuild")
      throw new TypeError("Invalid cancellation reason");
  } else if (event.type === "session.end") {
    if (!new Set(["host_end", "host_delete", "inactivity"]).has(event.reason))
      throw new TypeError("Invalid terminal reason");
    if (!HASH_PATTERN.test(event.finalMessageSetDigest))
      throw new TypeError("Invalid terminal digest");
    validateSequence(event.maxEnqueueSequence);
    if (event.enqueueSequence !== event.maxEnqueueSequence + 1)
      throw new TypeError("Invalid terminal sequence");
  } else if (event.type === "session.start") {
    if (event.requestedGeneration !== undefined) validateGeneration(event.requestedGeneration);
    if (
      event.sensitivity !== undefined &&
      event.sensitivity !== "public" &&
      event.sensitivity !== "internal"
    )
      throw new TypeError("Invalid session sensitivity");
    if (
      event.metadata !== undefined &&
      (event.metadata === null ||
        typeof event.metadata !== "object" ||
        Array.isArray(event.metadata) ||
        Object.values(event.metadata).some((value) => typeof value !== "string"))
    )
      throw new TypeError("Invalid session metadata");
  }
}

function acknowledgementIdentity(
  event: Readonly<Record<string, unknown>>
): Record<string, unknown> {
  const base = {
    eventId: event.eventId,
    enqueueSequence: event.enqueueSequence,
    type: event.type,
  };
  if (event.type === "turn.append")
    return {
      ...base,
      sourceGeneration: event.sourceGeneration,
      hostMessageId: event.hostMessageId,
      role: event.role,
      contentHash: event.contentHash,
      ...(event.chunk === undefined ? {} : { chunk: event.chunk }),
    };
  if (event.type === "turn.retract")
    return {
      ...base,
      sourceGeneration: event.sourceGeneration,
      hostMessageId: event.hostMessageId,
      reason: event.reason,
    };
  if (event.type === "sequence.loss")
    return {
      ...base,
      sourceGeneration: event.sourceGeneration,
      reason: event.reason,
      lostEventType: event.lostEventType,
      lostHostMessageId: event.lostHostMessageId,
      lostRole: event.lostRole,
      lostContentHash: event.lostContentHash,
    };
  if (event.type === "event.cancel")
    return {
      ...base,
      sourceGeneration: event.sourceGeneration,
      targetEventId: event.targetEventId,
      reason: event.reason,
    };
  if (event.type === "session.end")
    return {
      ...base,
      sourceGeneration: event.sourceGeneration,
      reason: event.reason,
      finalMessageSetDigest: event.finalMessageSetDigest,
      maxEnqueueSequence: event.maxEnqueueSequence,
    };
  if (event.type === "session.start")
    return {
      ...base,
      ...(event.requestedGeneration === undefined
        ? {}
        : { requestedGeneration: event.requestedGeneration }),
      ...(event.sensitivity === undefined ? {} : { sensitivity: event.sensitivity }),
      ...(event.metadata === undefined ? {} : { metadata: event.metadata }),
    };
  return base;
}

export function computeAcknowledgementIdentityHash(
  event: Readonly<Record<string, unknown>>
): string {
  return createHash("sha256")
    .update(canonicalJson(acknowledgementIdentity(event)))
    .digest("hex");
}

async function mutateState(
  host: string,
  clientInstanceId: string,
  hostSessionId: string,
  mutate: (state: SessionState, paths: HarnessPaths) => void | Promise<void>,
  options: StateOptions
): Promise<SessionStateResult> {
  const paths = await ensureSecureHarnessPaths(options);
  const key = sourceSessionKey(host, clientInstanceId, hostSessionId);
  return withAdvisoryLock(paths, sessionLockName(key), async () => {
    const path = statePath(paths, key);
    await recoverStateTemporaryFile(paths, key, options);
    const state = await readStateAt(path);
    await mutate(state, paths);
    await atomicWritePrivateFile(path, canonicalJson(state), options);
    return { ...state, path };
  });
}

export async function readSessionState(
  host: string,
  clientInstanceId: string,
  hostSessionId: string,
  options: StateOptions = {}
): Promise<SessionStateResult> {
  const paths = await ensureSecureHarnessPaths(options);
  const key = sourceSessionKey(host, clientInstanceId, hostSessionId);
  return withAdvisoryLock(paths, sessionLockName(key), () =>
    readSessionStateUnderLock(host, clientInstanceId, hostSessionId, paths)
  );
}

export async function readSessionStateUnderLock(
  host: string,
  clientInstanceId: string,
  hostSessionId: string,
  paths: HarnessPaths
): Promise<SessionStateResult> {
  const key = sourceSessionKey(host, clientInstanceId, hostSessionId);
  await recoverStateTemporaryFile(paths, key);
  const path = statePath(paths, key);
  return { ...(await readStateAt(path)), path };
}

export async function recordEnqueuedSequence(
  host: string,
  clientInstanceId: string,
  hostSessionId: string,
  enqueueSequence: number,
  acknowledgementHash: string,
  paths: HarnessPaths,
  options: AtomicWriteOptions = {}
): Promise<void> {
  validateSequence(enqueueSequence);
  if (!HASH_PATTERN.test(acknowledgementHash))
    throw new TypeError("Invalid enqueued event identity");
  const key = sourceSessionKey(host, clientInstanceId, hostSessionId);
  const path = statePath(paths, key);
  await recoverStateTemporaryFile(paths, key, options);
  const state = await readStateAt(path);
  state.lastEnqueuedSequence = Math.max(state.lastEnqueuedSequence, enqueueSequence);
  const existing = state.enqueuedAcknowledgementHashes[String(enqueueSequence)];
  if (existing !== undefined && existing !== acknowledgementHash)
    throw new Error("Enqueued sequence identity changed");
  state.enqueuedAcknowledgementHashes[String(enqueueSequence)] = acknowledgementHash;
  await atomicWritePrivateFile(path, canonicalJson(state), options);
}

export async function repairEnqueuedSequencesUnderLock(
  host: string,
  clientInstanceId: string,
  hostSessionId: string,
  entries: readonly { enqueueSequence: number; acknowledgementHash: string }[],
  paths: HarnessPaths,
  options: AtomicWriteOptions = {}
): Promise<void> {
  const key = sourceSessionKey(host, clientInstanceId, hostSessionId);
  const path = statePath(paths, key);
  await recoverStateTemporaryFile(paths, key, options);
  const state = await readStateAt(path);
  let changed = false;
  for (const { enqueueSequence, acknowledgementHash } of entries) {
    validateSequence(enqueueSequence);
    if (!HASH_PATTERN.test(acknowledgementHash))
      throw new TypeError("Invalid recovered enqueued event identity");
    const sequence = String(enqueueSequence);
    const acknowledged = Object.values(state.acknowledgedEvents).find(
      (event) => event.enqueueSequence === enqueueSequence
    );
    const tombstone = state.sequenceTombstones[sequence];
    const enqueued = state.enqueuedAcknowledgementHashes[sequence];
    const replacement = state.pendingSequenceReplacements[sequence];
    const completesReplacement =
      replacement !== undefined &&
      replacement.previousAcknowledgementHash === enqueued &&
      replacement.replacementAcknowledgementHash === acknowledgementHash;
    const retainsOriginal =
      replacement !== undefined &&
      replacement.previousAcknowledgementHash === enqueued &&
      replacement.previousAcknowledgementHash === acknowledgementHash;
    if (
      (acknowledged !== undefined && acknowledged.acknowledgementHash !== acknowledgementHash) ||
      (tombstone !== undefined && tombstone !== acknowledgementHash) ||
      (replacement !== undefined && !completesReplacement && !retainsOriginal) ||
      (enqueued !== undefined && enqueued !== acknowledgementHash && !completesReplacement) ||
      (enqueueSequence <= state.compactedAcknowledgementWatermark && tombstone === undefined) ||
      (enqueueSequence <= state.lastEnqueuedSequence &&
        acknowledged === undefined &&
        tombstone === undefined &&
        enqueued === undefined)
    ) {
      throw new Error(
        "Recovered enqueued sequence identity conflicts with durable acknowledgement state"
      );
    }
    if (tombstone === acknowledgementHash) continue;
    if (state.enqueuedAcknowledgementHashes[sequence] !== acknowledgementHash) {
      state.enqueuedAcknowledgementHashes[sequence] = acknowledgementHash;
      changed = true;
    }
    if (replacement !== undefined) {
      delete state.pendingSequenceReplacements[sequence];
      changed = true;
    }
    if (enqueueSequence > state.lastEnqueuedSequence) {
      state.lastEnqueuedSequence = enqueueSequence;
      changed = true;
    }
  }
  if (changed) await atomicWritePrivateFile(path, canonicalJson(state), options);
}

export async function beginEnqueuedSequenceReplacementUnderLock(
  host: string,
  clientInstanceId: string,
  hostSessionId: string,
  enqueueSequence: number,
  previousAcknowledgementHash: string,
  replacementAcknowledgementHash: string,
  paths: HarnessPaths,
  options: AtomicWriteOptions = {}
): Promise<void> {
  validateSequence(enqueueSequence);
  if (
    !HASH_PATTERN.test(previousAcknowledgementHash) ||
    !HASH_PATTERN.test(replacementAcknowledgementHash)
  )
    throw new TypeError("Invalid sequence replacement identity");
  const path = statePath(paths, sourceSessionKey(host, clientInstanceId, hostSessionId));
  await recoverStateTemporaryFile(
    paths,
    sourceSessionKey(host, clientInstanceId, hostSessionId),
    options
  );
  const state = await readStateAt(path);
  const sequence = String(enqueueSequence);
  if (
    enqueueSequence <= state.acknowledgedWatermark ||
    state.sequenceTombstones[sequence] !== undefined ||
    Object.values(state.acknowledgedEvents).some(
      (event) => event.enqueueSequence === enqueueSequence
    )
  )
    throw new Error("Cannot replace an acknowledged sequence");
  const existing = state.pendingSequenceReplacements[sequence];
  if (
    state.enqueuedAcknowledgementHashes[sequence] !== previousAcknowledgementHash ||
    (existing !== undefined &&
      (existing.previousAcknowledgementHash !== previousAcknowledgementHash ||
        existing.replacementAcknowledgementHash !== replacementAcknowledgementHash))
  )
    throw new Error("Sequence replacement identity changed");
  state.pendingSequenceReplacements[sequence] = {
    previousAcknowledgementHash,
    replacementAcknowledgementHash,
  };
  await atomicWritePrivateFile(path, canonicalJson(state), options);
}

export async function acknowledgeEvent(
  host: string,
  clientInstanceId: string,
  hostSessionId: string,
  event: AcknowledgedEvent,
  options: StateOptions & { effectiveGeneration?: number } = {}
): Promise<SessionStateResult> {
  validateAcknowledgement(event);
  if (options.effectiveGeneration !== undefined) validateGeneration(options.effectiveGeneration);
  return mutateState(
    host,
    clientInstanceId,
    hostSessionId,
    (state) => {
      if (event.enqueueSequence > state.lastEnqueuedSequence)
        throw new Error("Acknowledged sequence was not enqueued");
      const acknowledgementHash = computeAcknowledgementIdentityHash(
        event as unknown as Readonly<Record<string, unknown>>
      );
      if (event.enqueueSequence <= state.compactedAcknowledgementWatermark) {
        if (
          state.sequenceTombstones[String(event.enqueueSequence)] === acknowledgementHash ||
          (event.type === "session.end" &&
            state.compactedTerminalAcknowledgementHashes[String(event.sourceGeneration)] ===
              acknowledgementHash)
        )
          return;
        throw new Error("Acknowledgement targets a compacted sequence");
      }
      if (
        event.type === "session.end" &&
        state.compactedTerminalAcknowledgementHashes[String(event.sourceGeneration)] ===
          acknowledgementHash
      )
        return;
      const compactedHash = state.sequenceTombstones[String(event.enqueueSequence)];
      if (compactedHash !== undefined) {
        if (compactedHash !== acknowledgementHash)
          throw new Error("Acknowledgement conflicts with compacted sequence identity");
        return;
      }
      const expectedHash = state.enqueuedAcknowledgementHashes[String(event.enqueueSequence)];
      if (expectedHash === undefined || expectedHash !== acknowledgementHash)
        throw new Error("Acknowledgement does not match enqueued event");
      const existing = state.acknowledgedEvents[event.eventId];
      if (existing !== undefined && existing.acknowledgementHash !== acknowledgementHash) {
        throw new Error("Acknowledged event identity changed");
      }
      if (existing !== undefined) return;
      const sequenceOwner = Object.entries(state.acknowledgedEvents).find(
        ([eventId, acknowledged]) =>
          eventId !== event.eventId && acknowledged.enqueueSequence === event.enqueueSequence
      );
      if (sequenceOwner !== undefined)
        throw new Error("Acknowledged sequence has conflicting event");
      // Keep the hash of the original request for replay validation, but store
      // this occurrence under the generation the server actually accepted it in.
      // A global requested-generation mapping cannot describe two occurrences
      // straddling an inactivity rollover.
      if (event.type !== "session.start" && options.effectiveGeneration !== undefined) {
        event = { ...event, sourceGeneration: options.effectiveGeneration };
      }
      state.acknowledgedEvents[event.eventId] = {
        enqueueSequence: event.enqueueSequence,
        ...(event.type === "session.start" ? {} : { sourceGeneration: event.sourceGeneration }),
        type: event.type,
        ...(options.effectiveGeneration === undefined
          ? {}
          : { effectiveGeneration: options.effectiveGeneration }),
        acknowledgementHash,
        ...(event.type === "session.end" ? { terminalDigest: event.finalMessageSetDigest } : {}),
        ...(event.type === "session.end" ? { acknowledgedAt: new Date().toISOString() } : {}),
      };
      if (event.type === "turn.append") {
        if (event.chunk !== undefined) {
          for (const partial of Object.values(state.acknowledgedMessageChunks ?? {})) {
            if (
              partial.hostMessageId === event.hostMessageId &&
              partial.sourceGeneration > event.sourceGeneration
            )
              event = { ...event, sourceGeneration: partial.sourceGeneration };
          }
        }
        const key = messageKey(event.sourceGeneration, event.hostMessageId);
        if (event.chunk !== undefined) {
          // An inactivity claim can land between fragments. Earlier fragments
          // move with the message when the later ACK materializes its successor.
          for (const [priorKey, partial] of Object.entries(state.acknowledgedMessageChunks ?? {})) {
            if (priorKey !== key && partial.hostMessageId === event.hostMessageId) {
              state.acknowledgedMessageChunks![key] = {
                ...partial,
                sourceGeneration: event.sourceGeneration,
              };
              delete state.acknowledgedMessageChunks![priorKey];
            }
          }
          const nextFull: MessageIdentity = {
            type: "M",
            sourceGeneration: event.sourceGeneration,
            hostMessageId: event.hostMessageId,
            role: event.role,
            contentHash: event.chunk.messageContentHash,
            retracted: false,
          };
          const priorFull = state.acknowledgedMessages[key] ?? state.messageTombstones[key];
          if (priorFull !== undefined && canonicalJson(priorFull) !== canonicalJson(nextFull)) {
            throw new Error("Acknowledged message identity changed");
          }
          if (priorFull === undefined) {
            state.acknowledgedMessageChunks ??= {};
            const partial = state.acknowledgedMessageChunks[key] ?? {
              sourceGeneration: event.sourceGeneration,
              hostMessageId: event.hostMessageId,
              role: event.role,
              chunkCount: event.chunk.chunkCount,
              messageContentHash: event.chunk.messageContentHash,
              chunks: {},
            };
            if (
              partial.role !== event.role ||
              partial.chunkCount !== event.chunk.chunkCount ||
              partial.messageContentHash !== event.chunk.messageContentHash ||
              (partial.chunks[String(event.chunk.chunkIndex)] !== undefined &&
                partial.chunks[String(event.chunk.chunkIndex)] !== event.contentHash)
            ) {
              throw new Error("Acknowledged message identity changed");
            }
            partial.chunks[String(event.chunk.chunkIndex)] = event.contentHash;
            if (Object.keys(partial.chunks).length === event.chunk.chunkCount) {
              state.acknowledgedMessages[key] = nextFull;
              delete state.acknowledgedMessageChunks[key];
              if (Object.keys(state.acknowledgedMessageChunks).length === 0) {
                delete state.acknowledgedMessageChunks;
              }
            } else {
              state.acknowledgedMessageChunks[key] = partial;
            }
          }
        } else {
          const next: MessageIdentity = {
            type: "M",
            sourceGeneration: event.sourceGeneration,
            hostMessageId: event.hostMessageId,
            role: event.role,
            contentHash: event.contentHash,
            retracted: false,
          };
          const prior = state.acknowledgedMessages[key] ?? state.messageTombstones[key];
          if (prior !== undefined && canonicalJson(prior) !== canonicalJson(next))
            throw new Error("Acknowledged message identity changed");
          state.acknowledgedMessages[key] = next;
        }
      } else if (event.type === "sequence.loss") {
        const key = messageKey(event.sourceGeneration, event.lostHostMessageId);
        const lostHostMessageId = event.lostHostMessageId;
        const prior =
          state.acknowledgedMessages[key] ??
          state.messageTombstones[key] ??
          (event.lostEventType === "turn.retract"
            ? Object.values(state.acknowledgedMessages).find(
                (message) => message.hostMessageId === lostHostMessageId
              )
            : undefined);
        if (event.lostEventType === "turn.retract") {
          if (
            prior === undefined ||
            prior.role !== event.lostRole ||
            prior.contentHash !== event.lostContentHash
          )
            throw new Error("Lost retraction target identity changed");
        } else if (prior !== undefined) {
          throw new Error("Lost append conflicts with acknowledged message identity");
        }
        const message: MessageIdentity = {
          type: "L",
          sourceGeneration: event.sourceGeneration,
          hostMessageId: event.lostHostMessageId,
          role: event.lostRole,
          contentHash: event.lostContentHash,
          retracted: event.lostEventType === "turn.retract",
          lossReason: event.reason,
          lostEventType: event.lostEventType,
        };
        state.acknowledgedMessages[key] = message;
        if (message.retracted) state.messageTombstones[key] = message;
      } else if (event.type === "turn.retract") {
        // A terminal predecessor cannot be mutated on the server: its
        // retraction is acknowledged in a successor, while this identity still
        // belongs to the predecessor's local message set.
        const targetMessageId = event.hostMessageId;
        const key =
          Object.keys({ ...state.messageTombstones, ...state.acknowledgedMessages }).find(
            (key) =>
              (state.acknowledgedMessages[key] ?? state.messageTombstones[key])?.hostMessageId ===
              targetMessageId
          ) ?? messageKey(event.sourceGeneration, event.hostMessageId);
        const prior = state.acknowledgedMessages[key] ?? state.messageTombstones[key];
        if (prior === undefined) throw new Error("Retraction target is not acknowledged");
        const tombstone = { ...prior, retracted: true, retractionReason: event.reason };
        state.acknowledgedMessages[key] = tombstone;
        state.messageTombstones[key] = tombstone;
      }
      const acknowledgedSequences = new Set(
        Object.values(state.acknowledgedEvents).map(({ enqueueSequence }) => enqueueSequence)
      );
      while (
        acknowledgedSequences.has(state.acknowledgedWatermark + 1) ||
        state.sequenceTombstones[String(state.acknowledgedWatermark + 1)] !== undefined
      )
        state.acknowledgedWatermark += 1;
    },
    options
  );
}

export async function writeGenerationMapping(
  host: string,
  clientInstanceId: string,
  hostSessionId: string,
  requestedGeneration: number,
  effectiveGeneration: number,
  options: StateOptions = {}
): Promise<SessionStateResult> {
  validateGeneration(requestedGeneration);
  validateGeneration(effectiveGeneration);
  return mutateState(
    host,
    clientInstanceId,
    hostSessionId,
    (state) => {
      const existing = state.generationMappings[String(requestedGeneration)];
      if (existing !== undefined && existing !== effectiveGeneration)
        throw new Error("Requested generation is already mapped differently");
      state.generationMappings[String(requestedGeneration)] = effectiveGeneration;
    },
    options
  );
}

export async function recoverNextSequence(
  host: string,
  clientInstanceId: string,
  hostSessionId: string,
  options: StateOptions = {}
): Promise<number> {
  const paths = await ensureSecureHarnessPaths(options);
  const state = await readStateAt(
    statePath(paths, sourceSessionKey(host, clientInstanceId, hostSessionId))
  );
  let maximum = Math.max(state.acknowledgedWatermark, state.lastEnqueuedSequence);
  for (const file of await listSecureRegularFiles(paths.outbox)) {
    if (!file.endsWith(".json")) continue;
    const event = JSON.parse(await readPrivateFile(file)) as {
      host?: string;
      clientInstanceId?: string;
      hostSessionId?: string;
      enqueueSequence?: number;
    };
    if (
      event.host === host &&
      event.clientInstanceId === clientInstanceId &&
      event.hostSessionId === hostSessionId &&
      Number.isSafeInteger(event.enqueueSequence) &&
      event.enqueueSequence! >= 1 &&
      event.enqueueSequence! <= HARNESS_MAX_ENQUEUE_SEQUENCE
    ) {
      maximum = Math.max(maximum, event.enqueueSequence!);
    }
  }
  if (maximum >= HARNESS_MAX_ENQUEUE_SEQUENCE) throw new Error("Enqueue sequence exhausted");
  return maximum + 1;
}

export async function compactTerminalState(
  host: string,
  clientInstanceId: string,
  hostSessionId: string,
  input: {
    sourceGeneration: number;
    terminalDigest: string;
    terminalAcknowledgedAt: string;
    retainUntil: string;
    now: string;
  },
  options: StateOptions = {}
): Promise<SessionStateResult> {
  validateGeneration(input.sourceGeneration);
  if (!HASH_PATTERN.test(input.terminalDigest)) throw new Error("Invalid terminal digest");
  const terminalAcknowledgedAt = Date.parse(input.terminalAcknowledgedAt);
  const retainUntil = Date.parse(input.retainUntil);
  const now = Date.parse(input.now);
  if (
    !Number.isFinite(terminalAcknowledgedAt) ||
    !Number.isFinite(retainUntil) ||
    !Number.isFinite(now) ||
    retainUntil < terminalAcknowledgedAt
  ) {
    throw new Error("Invalid terminal retention date");
  }
  return mutateState(
    host,
    clientInstanceId,
    hostSessionId,
    async (state, paths) => {
      const pendingAcknowledgementHashes = new Map<number, string>();
      for (const file of await listSecureRegularFiles(paths.outbox)) {
        if (!file.endsWith(".json")) continue;
        const event = JSON.parse(await readPrivateFile(file)) as Record<string, unknown>;
        if (
          event.host !== host ||
          event.clientInstanceId !== clientInstanceId ||
          event.hostSessionId !== hostSessionId ||
          !Number.isSafeInteger(event.enqueueSequence)
        )
          continue;
        pendingAcknowledgementHashes.set(
          event.enqueueSequence as number,
          computeAcknowledgementIdentityHash(event)
        );
      }
      const terminalAcknowledgement = Object.values(state.acknowledgedEvents).find(
        (event) =>
          event.type === "session.end" &&
          event.sourceGeneration === input.sourceGeneration &&
          event.terminalDigest === input.terminalDigest
      );
      if (terminalAcknowledgement === undefined) {
        if (
          state.terminalDigests[String(input.sourceGeneration)] === input.terminalDigest &&
          state.compactedTerminalAcknowledgementHashes[String(input.sourceGeneration)] !== undefined
        ) {
          for (const sequence of Object.keys(state.sequenceTombstones))
            if (
              pendingAcknowledgementHashes.get(Number(sequence)) !==
              state.sequenceTombstones[sequence]
            )
              delete state.sequenceTombstones[sequence];
          return;
        }
        throw new Error("Matching terminal acknowledgement is required before compaction");
      }
      const recordedAcknowledgedAt = Date.parse(terminalAcknowledgement.acknowledgedAt ?? "");
      if (
        !Number.isFinite(recordedAcknowledgedAt) ||
        terminalAcknowledgedAt !== recordedAcknowledgedAt ||
        retainUntil < recordedAcknowledgedAt
      )
        throw new Error("Retention does not match the recorded terminal acknowledgement");
      const recordedRetainUntil = Date.parse(terminalAcknowledgement.retainUntil ?? "");
      if (terminalAcknowledgement.retainUntil !== undefined && retainUntil !== recordedRetainUntil)
        throw new Error("Retention does not match the recorded terminal deadline");
      terminalAcknowledgement.retainUntil ??= new Date(retainUntil).toISOString();
      state.terminalDigests[String(input.sourceGeneration)] = input.terminalDigest;
      if (Date.now() < retainUntil) return;
      if (terminalAcknowledgement.enqueueSequence > state.acknowledgedWatermark)
        throw new Error("Terminal sequence is beyond the contiguous acknowledged watermark");
      const compactedThrough = terminalAcknowledgement.enqueueSequence;
      const compactedGenerations = new Set<number>();
      for (const identity of Object.values(state.acknowledgedEvents)) {
        if (identity.enqueueSequence > compactedThrough || identity.type !== "session.end")
          continue;
        const acknowledgedAt = Date.parse(identity.acknowledgedAt ?? "");
        if (!Number.isFinite(acknowledgedAt))
          throw new Error("Completed generation has no durable acknowledgement timestamp");
        if (identity.retainUntil === undefined) continue;
        if (Date.now() < Date.parse(identity.retainUntil)) continue;
        compactedGenerations.add(identity.sourceGeneration!);
        state.terminalDigests[String(identity.sourceGeneration)] = identity.terminalDigest!;
        state.compactedTerminalAcknowledgementHashes[String(identity.sourceGeneration)] =
          identity.acknowledgementHash;
      }
      for (const [key, identity] of Object.entries(state.acknowledgedMessages)) {
        if (!compactedGenerations.has(identity.sourceGeneration)) continue;
        state.messageTombstones[key] = identity;
        delete state.acknowledgedMessages[key];
      }
      for (const [eventId, identity] of Object.entries(state.acknowledgedEvents)) {
        if (
          identity.enqueueSequence > compactedThrough ||
          (identity.sourceGeneration !== undefined &&
            !compactedGenerations.has(identity.sourceGeneration))
        )
          continue;
        state.sequenceTombstones[String(identity.enqueueSequence)] = identity.acknowledgementHash;
        delete state.enqueuedAcknowledgementHashes[String(identity.enqueueSequence)];
        delete state.acknowledgedEvents[eventId];
      }
      const liveSequences = new Set(
        Object.values(state.acknowledgedEvents).map(({ enqueueSequence }) => enqueueSequence)
      );
      while (state.compactedAcknowledgementWatermark < state.acknowledgedWatermark) {
        const next = state.compactedAcknowledgementWatermark + 1;
        if (
          liveSequences.has(next) ||
          state.enqueuedAcknowledgementHashes[String(next)] !== undefined
        )
          break;
        state.compactedAcknowledgementWatermark = next;
      }
      for (const sequence of Object.keys(state.sequenceTombstones))
        if (
          pendingAcknowledgementHashes.get(Number(sequence)) !== state.sequenceTombstones[sequence]
        )
          delete state.sequenceTombstones[sequence];
    },
    options
  );
}
