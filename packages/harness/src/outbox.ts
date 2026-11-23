import type { TurnOrigin } from "./content-origin.js";
import { createHash, randomUUID } from "node:crypto";
import { rename, stat, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  HARNESS_CHUNK_VERSION,
  HARNESS_MAX_CHUNKS_PER_MESSAGE,
  HARNESS_MAX_GENERATION,
  HARNESS_MAX_IDENTITY_BYTES,
  HARNESS_MAX_MESSAGE_BYTES,
  canonicalJson,
  sha256Hex,
} from "@mnemo-ai/types/harness-runtime";
import {
  atomicWritePrivateFile,
  ensureSecureHarnessPaths,
  fsyncDirectory,
  listSecureRegularFiles,
  readPrivateFile,
  recoverAtomicTemporaryFiles,
  sessionLockName,
  withAdvisoryLock,
  writeFidelityFailureLatch,
  type AtomicWriteOptions,
  type HarnessPaths,
} from "./fs-security.js";
import { computePayloadHash } from "./protocol.js";
import { normalizeVisibleMessage, splitUtf8Chunks } from "./sanitize.js";
import {
  beginEnqueuedSequenceReplacementUnderLock,
  computeAcknowledgementIdentityHash,
  readSessionStateUnderLock,
  recordEnqueuedSequence,
  repairEnqueuedSequencesUnderLock,
  recoverNextSequence,
  sourceSessionKey,
  type HarnessTurnAppendChunk,
} from "./state.js";

const DEFAULT_NORMAL_BYTES = 32 * 1024 * 1024;
const DEFAULT_MARKER_RESERVE_BYTES = 1024 * 1024;
const DEFAULT_AUDIT_BYTES = 4 * 1024 * 1024;
const DEFAULT_QUARANTINE_BYTES = 16 * 1024 * 1024;

interface OutboxEventBase {
  eventId: string;
  host: "opencode" | "claude-code" | "codex";
  hostSessionId: string;
  clientInstanceId: string;
  enqueueSequence: number;
  occurredAt: string;
  payloadHash: string;
  normalizationVersion: 1;
}

export type HarnessOutboxEvent =
  | (OutboxEventBase & {
      type: "session.start";
      requestedGeneration?: number;
      sensitivity?: "public" | "internal";
      metadata?: Record<string, string>;
    })
  | (OutboxEventBase & {
      type: "turn.append";
      turnOrigin?: TurnOrigin;
      turnOriginEvidence?: string;
      sourceGeneration: number;
      hostMessageId: string;
      supersedesSourceMessageId?: string;
      role: "user" | "assistant";
      content: string;
      contentHash: string;
      chunk?: HarnessTurnAppendChunk;
    })
  | (OutboxEventBase & {
      type: "turn.retract";
      sourceGeneration: number;
      hostMessageId: string;
      reason: "superseded" | "branch_removed";
    })
  | (OutboxEventBase & {
      type: "sequence.loss";
      sourceGeneration: number;
      reason: "capacity" | "invalid_payload" | "permanent_rejection";
      lostEventType: "turn.append" | "turn.retract";
      lostHostMessageId: string;
      lostRole: "user" | "assistant";
      lostContentHash: string;
    })
  | (OutboxEventBase & {
      type: "event.cancel";
      sourceGeneration: number;
      targetEventId: string;
      reason: "generation_redirect" | "terminal_rebuild";
    })
  | (OutboxEventBase & {
      type: "session.end";
      sourceGeneration: number;
      reason: "host_end" | "host_delete" | "inactivity";
      finalMessageSetDigest: string;
      maxEnqueueSequence: number;
    });

export interface EnqueueVisibleMessageInput {
  turnOrigin?: TurnOrigin;
  turnOriginEvidence?: string;
  host: "opencode" | "claude-code" | "codex";
  hostSessionId: string;
  clientInstanceId: string;
  sourceGeneration: number;
  hostMessageId: string;
  supersedesSourceMessageId?: string;
  role: "user" | "assistant";
  content: string;
  occurredAt?: string;
}

export interface EnqueueEventCancellationInput {
  host: "opencode" | "claude-code" | "codex";
  hostSessionId: string;
  clientInstanceId: string;
  sourceGeneration: number;
  targetEventId: string;
  reason: "generation_redirect" | "terminal_rebuild";
  occurredAt?: string;
}

export interface EnqueueSessionStartInput {
  host: "opencode" | "claude-code" | "codex";
  hostSessionId: string;
  clientInstanceId: string;
  requestedGeneration?: number;
  sensitivity?: "public" | "internal";
  metadata?: Record<string, string>;
  occurredAt?: string;
}

export interface EnqueueTurnRetractionInput {
  host: "opencode" | "claude-code" | "codex";
  hostSessionId: string;
  clientInstanceId: string;
  sourceGeneration: number;
  hostMessageId: string;
  reason: "superseded" | "branch_removed";
  occurredAt?: string;
}

export interface EnqueueSessionEndInput {
  host: "opencode" | "claude-code" | "codex";
  hostSessionId: string;
  clientInstanceId: string;
  sourceGeneration: number;
  reason: "host_end" | "host_delete" | "inactivity";
  finalMessageSetDigest: string;
  maxEnqueueSequence?: number;
  occurredAt?: string;
}

export interface OutboxOptions extends AtomicWriteOptions {
  home?: string;
  capacity?: {
    normalBytes: number;
    markerReserveBytes: number;
    auditBytes?: number;
    quarantineBytes?: number;
  };
}

interface ResolvedCapacity {
  normalBytes: number;
  markerReserveBytes: number;
  auditBytes: number;
  quarantineBytes: number;
}

export interface PendingEvent {
  path: string;
  bytes: number;
  event: HarnessOutboxEvent;
}

export interface EnqueueResult extends PendingEvent {
  fullFidelity: boolean;
  chunks?: PendingEvent[];
}

export class OutboxDurabilityError extends Error {
  readonly fullFidelity = false;
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OutboxDurabilityError";
  }
}

function eventWithPayloadHash<T extends Readonly<Record<string, unknown>>>(
  body: T
): T & {
  payloadHash: string;
} {
  return { ...body, payloadHash: computePayloadHash(body) };
}

function finalName(event: HarnessOutboxEvent): string {
  const key = sourceSessionKey(event.host, event.clientInstanceId, event.hostSessionId);
  return `${key}-${String(event.enqueueSequence).padStart(16, "0")}.json`;
}

function parsePendingEvent(bytes: string): HarnessOutboxEvent {
  const event = JSON.parse(bytes) as HarnessOutboxEvent;
  if (event === null || typeof event !== "object" || canonicalJson(event) !== bytes)
    throw new Error("Malformed pending harness event");
  const fields = new Set([
    "eventId",
    "host",
    "hostSessionId",
    "clientInstanceId",
    "enqueueSequence",
    "occurredAt",
    "payloadHash",
    "normalizationVersion",
    "type",
    ...(event.type === "session.start" ? ["requestedGeneration", "sensitivity", "metadata"] : []),
    ...(event.type === "turn.append"
      ? [
          "sourceGeneration",
          "hostMessageId",
          "supersedesSourceMessageId",
          "role",
          "content",
          "contentHash",
          "turnOrigin",
          "turnOriginEvidence",
          "chunk",
        ]
      : []),
    ...(event.type === "turn.retract" ? ["sourceGeneration", "hostMessageId", "reason"] : []),
    ...(event.type === "sequence.loss"
      ? [
          "sourceGeneration",
          "reason",
          "lostEventType",
          "lostHostMessageId",
          "lostRole",
          "lostContentHash",
        ]
      : []),
    ...(event.type === "event.cancel" ? ["sourceGeneration", "targetEventId", "reason"] : []),
    ...(event.type === "session.end"
      ? ["sourceGeneration", "reason", "finalMessageSetDigest", "maxEnqueueSequence"]
      : []),
  ]);
  if (Object.keys(event).some((key) => !fields.has(key)))
    throw new Error("Unexpected pending event field");
  assertPendingIdentity(event.eventId);
  assertPendingIdentity(event.hostSessionId);
  assertPendingIdentity(event.clientInstanceId);
  if (
    !new Set(["opencode", "claude-code", "codex"]).has(event.host) ||
    !Number.isSafeInteger(event.enqueueSequence) ||
    event.enqueueSequence < 1 ||
    event.normalizationVersion !== 1 ||
    !HASH_PATTERN.test(event.payloadHash) ||
    computePayloadHash(event as unknown as Readonly<Record<string, unknown>>) !==
      event.payloadHash ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      event.occurredAt
    ) ||
    !Number.isFinite(Date.parse(event.occurredAt)) ||
    Date.parse(event.occurredAt) > Date.now() + 86_400_000
  )
    throw new Error("Malformed pending harness metadata");
  if (event.type === "turn.append") {
    assertPendingIdentity(event.hostMessageId);
    if (event.supersedesSourceMessageId !== undefined)
      assertPendingIdentity(event.supersedesSourceMessageId);
    if (
      !validGeneration(event.sourceGeneration) ||
      (event.role !== "user" && event.role !== "assistant") ||
      typeof event.content !== "string" ||
      Buffer.byteLength(event.content, "utf8") > HARNESS_MAX_MESSAGE_BYTES ||
      !HASH_PATTERN.test(event.contentHash) ||
      createHash("sha256").update(event.content).digest("hex") !== event.contentHash ||
      (event.chunk !== undefined &&
        (event.chunk === null ||
          typeof event.chunk !== "object" ||
          event.chunk.version !== HARNESS_CHUNK_VERSION ||
          !Number.isSafeInteger(event.chunk.chunkCount) ||
          event.chunk.chunkCount < 2 ||
          event.chunk.chunkCount > HARNESS_MAX_CHUNKS_PER_MESSAGE ||
          !Number.isSafeInteger(event.chunk.chunkIndex) ||
          event.chunk.chunkIndex < 0 ||
          event.chunk.chunkIndex >= event.chunk.chunkCount ||
          !HASH_PATTERN.test(event.chunk.messageContentHash)))
    )
      throw new Error("Malformed append event");
  } else if (event.type === "turn.retract") {
    assertPendingIdentity(event.hostMessageId);
    if (
      !validGeneration(event.sourceGeneration) ||
      (event.reason !== "superseded" && event.reason !== "branch_removed")
    )
      throw new Error("Malformed retraction event");
  } else if (event.type === "sequence.loss") {
    assertPendingIdentity(event.lostHostMessageId);
    if (
      !validGeneration(event.sourceGeneration) ||
      !new Set(["capacity", "invalid_payload", "permanent_rejection"]).has(event.reason) ||
      (event.lostEventType !== "turn.append" && event.lostEventType !== "turn.retract") ||
      (event.lostRole !== "user" && event.lostRole !== "assistant") ||
      !HASH_PATTERN.test(event.lostContentHash)
    )
      throw new Error("Malformed loss event");
  } else if (event.type === "event.cancel") {
    assertPendingIdentity(event.targetEventId);
    if (
      !validGeneration(event.sourceGeneration) ||
      (event.reason !== "generation_redirect" && event.reason !== "terminal_rebuild")
    )
      throw new Error("Malformed cancellation event");
  } else if (event.type === "session.end") {
    if (
      !validGeneration(event.sourceGeneration) ||
      !new Set(["host_end", "host_delete", "inactivity"]).has(event.reason) ||
      !HASH_PATTERN.test(event.finalMessageSetDigest) ||
      !Number.isSafeInteger(event.maxEnqueueSequence) ||
      event.maxEnqueueSequence < 1 ||
      event.enqueueSequence !== event.maxEnqueueSequence + 1
    )
      throw new Error("Malformed terminal event");
  } else if (event.type === "session.start") {
    if (
      (event.requestedGeneration !== undefined && !validGeneration(event.requestedGeneration)) ||
      (event.sensitivity !== undefined &&
        event.sensitivity !== "public" &&
        event.sensitivity !== "internal") ||
      (event.metadata !== undefined &&
        (event.metadata === null ||
          typeof event.metadata !== "object" ||
          Array.isArray(event.metadata) ||
          Object.values(event.metadata).some((value) => typeof value !== "string")))
    )
      throw new Error("Malformed session start event");
  } else throw new Error("Malformed pending event type");
  return event;
}

const HASH_PATTERN = /^[0-9a-f]{64}$/;

function assertPendingIdentity(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > HARNESS_MAX_IDENTITY_BYTES
  )
    throw new Error("Malformed pending harness identity");
}

function validGeneration(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= HARNESS_MAX_GENERATION
  );
}

async function quarantineMalformedFinal(
  paths: HarnessPaths,
  path: string,
  options: OutboxOptions,
  capacity: ResolvedCapacity
): Promise<void> {
  const bytes = await readPrivateFile(path);
  const sourceNameHash = createHash("sha256").update(basename(path)).digest("hex");
  const contentHash = createHash("sha256").update(bytes).digest("hex");
  const quarantineId = `${sourceNameHash}.${contentHash}`;
  const target = join(paths.quarantine, `${quarantineId}.invalid`);
  let targetExists = false;
  try {
    const existing = await readPrivateFile(target);
    if (existing !== bytes) throw new Error("Quarantine identity collision");
    targetExists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!targetExists) {
    if (
      (await directoryUsage(paths.quarantine)) + Buffer.byteLength(bytes) >
      capacity.quarantineBytes
    ) {
      await writeFidelityFailureLatch(paths, "malformed_pending_event", options);
      throw new OutboxDurabilityError("Quarantine capacity exhausted");
    }
    await rename(path, target);
    await options.boundary?.("rename", target);
    await fsyncDirectory(paths.quarantine);
    await options.boundary?.("directory-fsync", paths.quarantine);
  } else {
    await unlink(path);
  }
  await fsyncDirectory(paths.outbox);
  await options.boundary?.("directory-fsync", paths.outbox);
  const audit = canonicalJson({
    version: 1,
    type: "quarantine.invalid",
    sourceNameHash,
    contentHash,
  });
  let auditFailure: unknown;
  try {
    await writeBoundedAudit(
      paths,
      join(paths.audit, `${quarantineId}.invalid.json`),
      audit,
      options,
      capacity
    );
  } catch (error) {
    auditFailure = error;
  }
  await writeFidelityFailureLatch(paths, "malformed_pending_event", options);
  if (auditFailure !== undefined)
    throw new OutboxDurabilityError("Could not durably audit malformed pending event", {
      cause: auditFailure,
    });
}

async function directoryUsage(path: string): Promise<number> {
  let bytes = 0;
  for (const file of await listSecureRegularFiles(path)) bytes += (await stat(file)).size;
  return bytes;
}

async function writeBoundedAudit(
  paths: HarnessPaths,
  target: string,
  bytes: string,
  options: OutboxOptions,
  capacity: ResolvedCapacity
): Promise<void> {
  try {
    const existing = await readPrivateFile(target);
    if (existing !== bytes) throw new Error("Audit identity collision");
    await fsyncDirectory(paths.audit);
    await options.boundary?.("directory-fsync", paths.audit);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if ((await directoryUsage(paths.audit)) + Buffer.byteLength(bytes) > capacity.auditBytes)
    throw new OutboxDurabilityError("Audit capacity exhausted");
  await atomicWritePrivateFile(target, bytes, options);
}

async function repairQuarantineAudits(
  paths: HarnessPaths,
  options: OutboxOptions,
  capacity: ResolvedCapacity
): Promise<void> {
  for (const path of await listSecureRegularFiles(paths.quarantine)) {
    if (path.endsWith(".loss-audit-repair.json")) {
      const audit = parseLossAuditRepair(await readPrivateFile(path));
      await writeBoundedAudit(
        paths,
        join(paths.audit, `${audit.eventId}.json`),
        canonicalJson(audit),
        options,
        capacity
      ).catch(async (error) => {
        await writeFidelityFailureLatch(paths, "loss_persistence_failed", options);
        throw error;
      });
      await writeFidelityFailureLatch(paths, "capture_loss", options);
      await unlink(path);
      await fsyncDirectory(paths.quarantine);
      continue;
    }
    const match = /^([0-9a-f]{64})\.([0-9a-f]{64})\.invalid$/.exec(basename(path));
    if (match === null) throw new OutboxDurabilityError("Malformed quarantine association");
    const contentHash = createHash("sha256")
      .update(await readPrivateFile(path))
      .digest("hex");
    if (contentHash !== match[2]) throw new OutboxDurabilityError("Quarantine content changed");
    await writeBoundedAudit(
      paths,
      join(paths.audit, `${match[1]}.${match[2]}.invalid.json`),
      canonicalJson({
        version: 1,
        type: "quarantine.invalid",
        sourceNameHash: match[1],
        contentHash: match[2],
      }),
      options,
      capacity
    ).catch(async (error) => {
      await writeFidelityFailureLatch(paths, "malformed_pending_event", options);
      throw error;
    });
    await writeFidelityFailureLatch(paths, "malformed_pending_event", options);
  }
}

function parseLossAuditRepair(bytes: string): ReturnType<typeof lossAuditBody> {
  const audit = JSON.parse(bytes) as ReturnType<typeof lossAuditBody>;
  if (
    audit === null ||
    typeof audit !== "object" ||
    canonicalJson(audit) !== bytes ||
    audit.version !== 1 ||
    audit.type !== "capture.loss" ||
    typeof audit.eventId !== "string" ||
    audit.eventId.length === 0 ||
    Buffer.byteLength(audit.eventId, "utf8") > HARNESS_MAX_IDENTITY_BYTES ||
    !Number.isSafeInteger(audit.enqueueSequence) ||
    audit.enqueueSequence < 1 ||
    !validGeneration(audit.sourceGeneration) ||
    !new Set(["capacity", "invalid_payload", "permanent_rejection"]).has(audit.reason) ||
    (audit.lostEventType !== "turn.append" && audit.lostEventType !== "turn.retract") ||
    typeof audit.lostHostMessageId !== "string" ||
    audit.lostHostMessageId.length === 0 ||
    Buffer.byteLength(audit.lostHostMessageId, "utf8") > HARNESS_MAX_IDENTITY_BYTES ||
    (audit.lostRole !== "user" && audit.lostRole !== "assistant") ||
    !HASH_PATTERN.test(audit.lostContentHash) ||
    !HASH_PATTERN.test(audit.sourceSessionKey)
  )
    throw new OutboxDurabilityError("Malformed loss audit repair metadata");
  return audit;
}

async function prepareStorageLocked(
  paths: HarnessPaths,
  options: OutboxOptions,
  capacity: ResolvedCapacity
): Promise<{ normal: number; markers: number; hasLoss: boolean; events: HarnessOutboxEvent[] }> {
  const globalTemps = await recoverAtomicTemporaryFiles(
    [paths.outbox, paths.audit, paths.quarantine],
    undefined,
    {
      ...options,
      beforeDiscard: () => writeFidelityFailureLatch(paths, "uncommitted_temporary_file", options),
    }
  );
  const fidelityTemps = await recoverAtomicTemporaryFiles(
    [paths.state],
    new Set(["full-fidelity.json"]),
    {
      ...options,
      beforeDiscard: () => writeFidelityFailureLatch(paths, "uncommitted_temporary_file", options),
    }
  );
  if (globalTemps.discarded + fidelityTemps.discarded > 0)
    await writeFidelityFailureLatch(paths, "uncommitted_temporary_file", options);
  // A prior quarantine rename is not considered resolved until both directory entries are synced.
  await fsyncDirectory(paths.quarantine);
  await fsyncDirectory(paths.outbox);
  await repairQuarantineAudits(paths, options, capacity);
  const usage = await pendingUsage(paths, options, capacity);
  if (usage.hasLoss) await writeFidelityFailureLatch(paths, "capture_loss", options);
  await repairLossAudits(paths, options, capacity);
  await repairPendingState(paths, usage.events, options);
  return usage;
}

async function pendingUsage(
  paths: HarnessPaths,
  options: OutboxOptions,
  capacity: ResolvedCapacity
): Promise<{ normal: number; markers: number; hasLoss: boolean; events: HarnessOutboxEvent[] }> {
  let normal = 0;
  let markers = 0;
  let hasLoss = false;
  const events: HarnessOutboxEvent[] = [];
  for (const path of await listSecureRegularFiles(paths.outbox)) {
    const bytes = (await stat(path)).size;
    let event: HarnessOutboxEvent;
    try {
      if (!path.endsWith(".json")) throw new Error("Unexpected outbox file");
      event = parsePendingEvent(await readPrivateFile(path));
    } catch {
      normal += bytes;
      await quarantineMalformedFinal(paths, path, options, capacity);
      normal -= bytes;
      continue;
    }
    if (event.type === "sequence.loss" || event.type === "event.cancel") {
      markers += bytes;
      if (event.type === "sequence.loss") hasLoss = true;
    } else normal += bytes;
    events.push(event);
  }
  return { normal, markers, hasLoss, events };
}

async function repairPendingState(
  paths: HarnessPaths,
  events: readonly HarnessOutboxEvent[],
  options: OutboxOptions
): Promise<void> {
  const sessions = new Map<string, { event: HarnessOutboxEvent; entries: Map<number, string> }>();
  for (const event of events) {
    const key = sourceSessionKey(event.host, event.clientInstanceId, event.hostSessionId);
    const acknowledgementHash = computeAcknowledgementIdentityHash(
      event as unknown as Readonly<Record<string, unknown>>
    );
    const session = sessions.get(key) ?? { event, entries: new Map<number, string>() };
    const existing = session.entries.get(event.enqueueSequence);
    if (existing !== undefined && existing !== acknowledgementHash)
      throw new OutboxDurabilityError("Conflicting durable finals own one enqueue sequence");
    session.entries.set(event.enqueueSequence, acknowledgementHash);
    sessions.set(key, session);
  }
  for (const [key, session] of sessions)
    await withAdvisoryLock(paths, sessionLockName(key), () =>
      repairEnqueuedSequencesUnderLock(
        session.event.host,
        session.event.clientInstanceId,
        session.event.hostSessionId,
        [...session.entries].map(([enqueueSequence, acknowledgementHash]) => ({
          enqueueSequence,
          acknowledgementHash,
        })),
        paths,
        options
      )
    );
}

async function persistEvent(
  paths: HarnessPaths,
  event: HarnessOutboxEvent,
  options: OutboxOptions,
  targetPath?: string
): Promise<PendingEvent> {
  const bytes = canonicalJson(event);
  const path = targetPath ?? join(paths.outbox, finalName(event));
  await atomicWritePrivateFile(path, bytes, options);
  const acknowledgementHash = computeAcknowledgementIdentityHash(
    event as unknown as Readonly<Record<string, unknown>>
  );
  if (targetPath === undefined)
    await recordEnqueuedSequence(
      event.host,
      event.clientInstanceId,
      event.hostSessionId,
      event.enqueueSequence,
      acknowledgementHash,
      paths,
      options
    );
  else
    await repairEnqueuedSequencesUnderLock(
      event.host,
      event.clientInstanceId,
      event.hostSessionId,
      [{ enqueueSequence: event.enqueueSequence, acknowledgementHash }],
      paths,
      options
    );
  return { path, bytes: Buffer.byteLength(bytes), event };
}

function lossFromAppend(
  input: EnqueueVisibleMessageInput,
  enqueueSequence: number,
  reason: "capacity" | "invalid_payload" | "permanent_rejection",
  contentHash: string
): HarnessOutboxEvent {
  const body = {
    eventId: randomUUID(),
    host: input.host,
    hostSessionId: input.hostSessionId,
    clientInstanceId: input.clientInstanceId,
    enqueueSequence,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    normalizationVersion: 1 as const,
    type: "sequence.loss" as const,
    sourceGeneration: input.sourceGeneration,
    reason,
    lostEventType: "turn.append" as const,
    lostHostMessageId: input.hostMessageId,
    lostRole: input.role,
    lostContentHash: contentHash,
  };
  return eventWithPayloadHash(body) as HarnessOutboxEvent;
}

async function writeLossAudit(
  paths: HarnessPaths,
  event: Extract<HarnessOutboxEvent, { type: "sequence.loss" }>,
  options: OutboxOptions,
  capacity: ResolvedCapacity
): Promise<void> {
  const audit = lossAuditBody(event);
  await writeBoundedAudit(
    paths,
    join(paths.audit, `${event.eventId}.json`),
    canonicalJson(audit),
    options,
    capacity
  );
}

function lossAuditBody(event: Extract<HarnessOutboxEvent, { type: "sequence.loss" }>) {
  return {
    version: 1,
    type: "capture.loss" as const,
    eventId: event.eventId,
    enqueueSequence: event.enqueueSequence,
    reason: event.reason,
    sourceGeneration: event.sourceGeneration,
    lostEventType: event.lostEventType,
    lostHostMessageId: event.lostHostMessageId,
    lostRole: event.lostRole,
    lostContentHash: event.lostContentHash,
    sourceSessionKey: sourceSessionKey(event.host, event.clientInstanceId, event.hostSessionId),
  };
}

async function writeLossAuditWithRepairJournal(
  paths: HarnessPaths,
  event: Extract<HarnessOutboxEvent, { type: "sequence.loss" }>,
  options: OutboxOptions,
  capacity: ResolvedCapacity
): Promise<void> {
  const audit = canonicalJson(lossAuditBody(event));
  const repairPath = join(
    paths.quarantine,
    `${createHash("sha256").update(event.eventId).digest("hex")}.loss-audit-repair.json`
  );
  if (
    (await directoryUsage(paths.quarantine)) + Buffer.byteLength(audit) >
    capacity.quarantineBytes
  )
    throw new OutboxDurabilityError("Repair metadata capacity exhausted");
  await atomicWritePrivateFile(repairPath, audit, options);
  await writeBoundedAudit(
    paths,
    join(paths.audit, `${event.eventId}.json`),
    audit,
    options,
    capacity
  );
  await unlink(repairPath);
  await fsyncDirectory(paths.quarantine);
}

async function repairLossAudits(
  paths: HarnessPaths,
  options: OutboxOptions,
  capacity: ResolvedCapacity
): Promise<void> {
  const auditNames = new Set(
    (await listSecureRegularFiles(paths.audit)).map((path) => basename(path))
  );
  for (const path of await listSecureRegularFiles(paths.outbox)) {
    if (!path.endsWith(".json")) continue;
    const event = parsePendingEvent(await readPrivateFile(path));
    if (event.type !== "sequence.loss" || auditNames.has(`${event.eventId}.json`)) continue;
    await writeLossAudit(paths, event, options, capacity).catch((error) =>
      latchFullFidelityFailure(paths, options, error)
    );
  }
}

async function latchFullFidelityFailure(
  paths: HarnessPaths,
  options: OutboxOptions,
  cause: unknown
): Promise<never> {
  const error = new OutboxDurabilityError("Could not durably record capture loss", {
    cause: cause instanceof Error ? cause : undefined,
  });
  await writeFidelityFailureLatch(paths, "loss_persistence_failed", options).catch((latchError) => {
    throw new OutboxDurabilityError("Could not durably latch capture degradation", {
      cause: latchError,
    });
  });
  throw error;
}

async function recordPersistenceFailure(
  paths: HarnessPaths,
  loss: Extract<HarnessOutboxEvent, { type: "sequence.loss" }>,
  options: OutboxOptions,
  cause: unknown,
  capacity: ResolvedCapacity,
  targetPath?: string
): Promise<never> {
  // A rename may already have committed the original event. Keep its identity;
  // replacing it here would bypass the durable same-sequence replacement journal.
  await (async () => {
    const path = targetPath ?? join(paths.outbox, finalName(loss));
    const existing = await readPrivateFile(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (existing !== undefined) {
      const event = parsePendingEvent(existing);
      await fsyncDirectory(paths.outbox);
      await repairEnqueuedSequencesUnderLock(
        event.host,
        event.clientInstanceId,
        event.hostSessionId,
        [
          {
            enqueueSequence: event.enqueueSequence,
            acknowledgementHash: computeAcknowledgementIdentityHash(
              event as unknown as Readonly<Record<string, unknown>>
            ),
          },
        ],
        paths,
        options
      );
      await fsyncDirectory(paths.state);
      return;
    }
    const usage = await pendingUsage(paths, options, capacity);
    if (usage.markers + Buffer.byteLength(canonicalJson(loss)) <= capacity.markerReserveBytes)
      await persistEvent(paths, loss, options, targetPath);
  })().catch(() => undefined);
  await writeLossAudit(paths, loss, options, capacity).catch(() => undefined);
  return latchFullFidelityFailure(paths, options, cause);
}

async function isFullFidelityLatched(paths: HarnessPaths): Promise<boolean> {
  try {
    await readPrivateFile(join(paths.state, "full-fidelity.json"));
    // Presence is itself the durable latch; malformed contents cannot restore fidelity.
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function validateSourceIdentity(input: {
  host: string;
  hostSessionId: string;
  clientInstanceId: string;
  sourceGeneration: number;
  occurredAt?: string;
}): void {
  if (!new Set<string>(["opencode", "claude-code", "codex"]).has(input.host)) {
    throw new TypeError("Unsupported harness host");
  }
  for (const [name, value] of [
    ["hostSessionId", input.hostSessionId],
    ["clientInstanceId", input.clientInstanceId],
  ] as const) {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      Buffer.byteLength(value, "utf8") > HARNESS_MAX_IDENTITY_BYTES
    )
      throw new TypeError(`${name} identity exceeds allowed bytes or is empty`);
  }
  if (
    !Number.isSafeInteger(input.sourceGeneration) ||
    input.sourceGeneration < 0 ||
    input.sourceGeneration > HARNESS_MAX_GENERATION
  ) {
    throw new TypeError("Invalid source generation");
  }
  if (input.occurredAt !== undefined) {
    const occurredAt = Date.parse(input.occurredAt);
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
        input.occurredAt
      ) ||
      !Number.isFinite(occurredAt) ||
      occurredAt > Date.now() + 24 * 60 * 60 * 1000
    ) {
      throw new TypeError("Invalid occurredAt timestamp");
    }
  }
}

function validateInput(input: EnqueueVisibleMessageInput): void {
  validateSourceIdentity(input);
  if (typeof input.hostMessageId !== "string" || input.hostMessageId.length === 0) {
    throw new TypeError("hostMessageId must be non-empty");
  }
  if (Buffer.byteLength(input.hostMessageId, "utf8") > HARNESS_MAX_IDENTITY_BYTES)
    throw new TypeError("hostMessageId identity exceeds allowed bytes");
  if (
    input.supersedesSourceMessageId !== undefined &&
    (input.supersedesSourceMessageId.length === 0 ||
      Buffer.byteLength(input.supersedesSourceMessageId, "utf8") > HARNESS_MAX_IDENTITY_BYTES)
  )
    throw new TypeError("supersedesSourceMessageId identity exceeds allowed bytes or is empty");
}

function resolveCapacity(options: OutboxOptions): ResolvedCapacity {
  const capacity = {
    normalBytes: options.capacity?.normalBytes ?? DEFAULT_NORMAL_BYTES,
    markerReserveBytes: options.capacity?.markerReserveBytes ?? DEFAULT_MARKER_RESERVE_BYTES,
    auditBytes: options.capacity?.auditBytes ?? DEFAULT_AUDIT_BYTES,
    quarantineBytes: options.capacity?.quarantineBytes ?? DEFAULT_QUARANTINE_BYTES,
  };
  if (Object.values(capacity).some((limit) => !Number.isSafeInteger(limit) || limit < 0))
    throw new TypeError("Outbox capacity must use non-negative safe integer byte limits");
  return capacity;
}

export async function enqueueVisibleMessage(
  input: EnqueueVisibleMessageInput,
  options: OutboxOptions = {}
): Promise<EnqueueResult> {
  validateInput(input);
  const normalized = normalizeVisibleMessage(
    { role: input.role, content: input.content },
    { truncate: false }
  );
  const textChunks = splitUtf8Chunks(normalized.content, HARNESS_MAX_MESSAGE_BYTES);
  const paths = await ensureSecureHarnessPaths(options);
  const sessionKey = sourceSessionKey(input.host, input.clientInstanceId, input.hostSessionId);
  const capacity = resolveCapacity(options);

  return withAdvisoryLock(paths, "global-capacity", async () => {
    const usage = await prepareStorageLocked(paths, options, capacity);
    return withAdvisoryLock(paths, sessionLockName(sessionKey), async () => {
      const occurredAt = input.occurredAt ?? new Date().toISOString();
      const firstSequence = await recoverNextSequence(
        input.host,
        input.clientInstanceId,
        input.hostSessionId,
        options
      );

      if (textChunks.length > HARNESS_MAX_CHUNKS_PER_MESSAGE) {
        const loss = lossFromAppend(
          input,
          firstSequence,
          "capacity",
          normalized.contentHash
        ) as Extract<HarnessOutboxEvent, { type: "sequence.loss" }>;
        const lossBytes = Buffer.byteLength(canonicalJson(loss));
        if (usage.markers + lossBytes > capacity.markerReserveBytes) {
          try {
            await writeLossAuditWithRepairJournal(paths, loss, options, capacity);
          } catch (error) {
            return latchFullFidelityFailure(paths, options, error);
          }
          return latchFullFidelityFailure(paths, options, new Error("Marker reserve exhausted"));
        }
        const persisted = await persistEvent(paths, loss, options).catch(async (error) => {
          await writeLossAudit(paths, loss, options, capacity).catch(() => undefined);
          return latchFullFidelityFailure(paths, options, error);
        });
        await writeLossAudit(paths, loss, options, capacity).catch((error) =>
          latchFullFidelityFailure(paths, options, error)
        );
        await writeFidelityFailureLatch(paths, "capture_loss", options).catch((error) =>
          latchFullFidelityFailure(paths, options, error)
        );
        return { ...persisted, fullFidelity: false };
      }

      const preflightBytes = textChunks.reduce((sum, chunkText, idx) => {
        const chunkHash = textChunks.length === 1 ? normalized.contentHash : sha256Hex(chunkText);
        const preflightBody = {
          eventId: "0".repeat(36),
          host: input.host,
          hostSessionId: input.hostSessionId,
          clientInstanceId: input.clientInstanceId,
          enqueueSequence: Number.MAX_SAFE_INTEGER,
          occurredAt: input.occurredAt ?? "9999-12-31T23:59:59.999Z",
          normalizationVersion: normalized.normalizationVersion,
          type: "turn.append" as const,
          sourceGeneration: input.sourceGeneration,
          hostMessageId: input.hostMessageId,
          ...(input.supersedesSourceMessageId === undefined
            ? {}
            : { supersedesSourceMessageId: input.supersedesSourceMessageId }),
          ...(input.turnOrigin
            ? {
                turnOrigin: input.turnOrigin,
                turnOriginEvidence: input.turnOriginEvidence ?? "host:typed_origin",
              }
            : {}),
          role: normalized.role,
          content: chunkText,
          contentHash: chunkHash,
          ...(textChunks.length === 1
            ? {}
            : {
                chunk: {
                  version: HARNESS_CHUNK_VERSION,
                  chunkIndex: idx,
                  chunkCount: textChunks.length,
                  messageContentHash: normalized.contentHash,
                },
              }),
        };
        return sum + Buffer.byteLength(canonicalJson(eventWithPayloadHash(preflightBody)));
      }, 0);

      const normalHasCapacity = usage.normal + preflightBytes <= capacity.normalBytes;
      const candidateEvents: HarnessOutboxEvent[] = textChunks.map((chunkText, idx) => {
        const chunkHash = textChunks.length === 1 ? normalized.contentHash : sha256Hex(chunkText);
        const body = {
          eventId: randomUUID(),
          host: input.host,
          hostSessionId: input.hostSessionId,
          clientInstanceId: input.clientInstanceId,
          enqueueSequence: firstSequence + idx,
          occurredAt,
          normalizationVersion: normalized.normalizationVersion,
          type: "turn.append" as const,
          sourceGeneration: input.sourceGeneration,
          hostMessageId: input.hostMessageId,
          ...(input.supersedesSourceMessageId === undefined
            ? {}
            : { supersedesSourceMessageId: input.supersedesSourceMessageId }),
          ...(input.turnOrigin
            ? {
                turnOrigin: input.turnOrigin,
                turnOriginEvidence: input.turnOriginEvidence ?? "host:typed_origin",
              }
            : {}),
          role: normalized.role,
          content: chunkText,
          contentHash: chunkHash,
          ...(textChunks.length === 1
            ? {}
            : {
                chunk: {
                  version: HARNESS_CHUNK_VERSION,
                  chunkIndex: idx,
                  chunkCount: textChunks.length,
                  messageContentHash: normalized.contentHash,
                },
              }),
        };
        return eventWithPayloadHash(body) as HarnessOutboxEvent;
      });

      const totalCandidateBytes = candidateEvents.reduce(
        (sum, ev) => sum + Buffer.byteLength(canonicalJson(ev)),
        0
      );

      if (normalHasCapacity && usage.normal + totalCandidateBytes <= capacity.normalBytes) {
        const persistedChunks: PendingEvent[] = [];
        for (const event of candidateEvents) {
          const loss = lossFromAppend(
            input,
            event.enqueueSequence,
            "invalid_payload",
            normalized.contentHash
          ) as Extract<HarnessOutboxEvent, { type: "sequence.loss" }>;
          const persisted = await persistEvent(paths, event, options).catch((error) =>
            recordPersistenceFailure(
              paths,
              loss,
              options,
              error,
              capacity,
              join(paths.outbox, finalName(event))
            )
          );
          persistedChunks.push(persisted);
        }
        const lastPersisted = persistedChunks[persistedChunks.length - 1]!;
        return {
          ...lastPersisted,
          ...(persistedChunks.length > 1 ? { chunks: persistedChunks } : {}),
          fullFidelity: !usage.hasLoss && !(await isFullFidelityLatched(paths)),
        };
      }

      const loss = lossFromAppend(
        input,
        firstSequence,
        "capacity",
        normalized.contentHash
      ) as Extract<HarnessOutboxEvent, { type: "sequence.loss" }>;
      const lossBytes = Buffer.byteLength(canonicalJson(loss));
      if (usage.markers + lossBytes > capacity.markerReserveBytes) {
        try {
          await writeLossAuditWithRepairJournal(paths, loss, options, capacity);
        } catch (error) {
          return latchFullFidelityFailure(paths, options, error);
        }
        return latchFullFidelityFailure(paths, options, new Error("Marker reserve exhausted"));
      }
      let persisted: PendingEvent;
      try {
        persisted = await persistEvent(paths, loss, options);
      } catch (error) {
        await writeLossAudit(paths, loss, options, capacity).catch(() => undefined);
        return latchFullFidelityFailure(paths, options, error);
      }
      await writeLossAudit(paths, loss, options, capacity).catch((error) =>
        latchFullFidelityFailure(paths, options, error)
      );
      await writeFidelityFailureLatch(paths, "capture_loss", options).catch((error) =>
        latchFullFidelityFailure(paths, options, error)
      );
      return { ...persisted, fullFidelity: false };
    });
  });
}

export async function readPendingEvents(options: OutboxOptions = {}): Promise<PendingEvent[]> {
  const paths = await ensureSecureHarnessPaths(options);
  const capacity = resolveCapacity(options);
  return withAdvisoryLock(paths, "global-capacity", async () => {
    await prepareStorageLocked(paths, options, capacity);
    return readPendingEventsLocked(paths, options, capacity);
  });
}

async function readPendingEventsLocked(
  paths: HarnessPaths,
  options: OutboxOptions,
  capacity: ResolvedCapacity
): Promise<PendingEvent[]> {
  const pending: PendingEvent[] = [];
  for (const path of await listSecureRegularFiles(paths.outbox)) {
    const bytes = (await stat(path)).size;
    let event: HarnessOutboxEvent;
    try {
      if (!path.endsWith(".json")) throw new Error("Unexpected outbox file");
      event = parsePendingEvent(await readPrivateFile(path));
    } catch {
      await quarantineMalformedFinal(paths, path, options, capacity);
      continue;
    }
    pending.push({
      path,
      bytes,
      event,
    });
  }
  return pending.sort((left, right) => left.event.enqueueSequence - right.event.enqueueSequence);
}

/**
 * Set aside a pending event the server will never accept.
 *
 * Shares the quarantine naming and audit convention with malformed events on
 * purpose: the recovery scan reads that convention, and a second layout here
 * would make it throw on files it cannot parse.
 *
 * Distinguished from a malformed event by its audit type and latch reason. This
 * event was well-formed and simply undeliverable — a 409 binding mismatch, or a
 * single event too large for the server — so what is recorded is a capture loss,
 * not a corruption.
 */
export async function quarantineUndeliverableEvent(
  path: string,
  options: OutboxOptions = {}
): Promise<void> {
  const paths = await ensureSecureHarnessPaths(options);
  const capacity = resolveCapacity(options);
  const bytes = await readPrivateFile(path);
  const sourceNameHash = createHash("sha256").update(basename(path)).digest("hex");
  const contentHash = createHash("sha256").update(bytes).digest("hex");
  const quarantineId = `${sourceNameHash}.${contentHash}`;
  const target = join(paths.quarantine, `${quarantineId}.invalid`);

  let targetExists = false;
  try {
    const existing = await readPrivateFile(target);
    if (existing !== bytes) throw new Error("Quarantine identity collision");
    targetExists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (targetExists) {
    await unlink(path);
  } else {
    if (
      (await directoryUsage(paths.quarantine)) + Buffer.byteLength(bytes) >
      capacity.quarantineBytes
    ) {
      await writeFidelityFailureLatch(paths, "capture_loss", options);
      throw new OutboxDurabilityError("Quarantine capacity exhausted");
    }
    await rename(path, target);
    await fsyncDirectory(paths.quarantine);
  }
  await fsyncDirectory(paths.outbox);

  await writeBoundedAudit(
    paths,
    join(paths.audit, `${quarantineId}.invalid.json`),
    canonicalJson({ version: 1, type: "quarantine.invalid", sourceNameHash, contentHash }),
    options,
    capacity
  ).catch(() => undefined);
  await writeFidelityFailureLatch(paths, "capture_loss", options);
}

export async function enqueueEventCancellation(
  input: EnqueueEventCancellationInput,
  options: OutboxOptions = {}
): Promise<EnqueueResult> {
  validateSourceIdentity(input);
  if (typeof input.targetEventId !== "string" || input.targetEventId.length === 0) {
    throw new TypeError("targetEventId must be non-empty");
  }
  if (Buffer.byteLength(input.targetEventId, "utf8") > HARNESS_MAX_IDENTITY_BYTES)
    throw new TypeError("targetEventId identity exceeds allowed bytes");
  if (input.reason !== "generation_redirect" && input.reason !== "terminal_rebuild") {
    throw new TypeError("Invalid event cancellation reason");
  }
  const paths = await ensureSecureHarnessPaths(options);
  const capacity = resolveCapacity(options);
  const sessionKey = sourceSessionKey(input.host, input.clientInstanceId, input.hostSessionId);
  return withAdvisoryLock(paths, "global-capacity", async () => {
    const usage = await prepareStorageLocked(paths, options, capacity);
    return withAdvisoryLock(paths, sessionLockName(sessionKey), async () => {
      const enqueueSequence = await recoverNextSequence(
        input.host,
        input.clientInstanceId,
        input.hostSessionId,
        options
      );
      const body = {
        eventId: randomUUID(),
        host: input.host,
        hostSessionId: input.hostSessionId,
        clientInstanceId: input.clientInstanceId,
        enqueueSequence,
        occurredAt: input.occurredAt ?? new Date().toISOString(),
        normalizationVersion: 1 as const,
        type: "event.cancel" as const,
        sourceGeneration: input.sourceGeneration,
        targetEventId: input.targetEventId,
        reason: input.reason,
      };
      const event = eventWithPayloadHash(body) as Extract<
        HarnessOutboxEvent,
        { type: "event.cancel" }
      >;
      if (usage.markers + Buffer.byteLength(canonicalJson(event)) > capacity.markerReserveBytes) {
        await writeBoundedAudit(
          paths,
          join(paths.audit, `${event.eventId}.json`),
          canonicalJson({
            version: 1,
            type: "capture.loss",
            eventId: event.eventId,
            enqueueSequence,
            sourceGeneration: event.sourceGeneration,
            sourceSessionKey: sessionKey,
            lostEventType: "event.cancel",
            targetEventId: event.targetEventId,
            reason: "capacity",
          }),
          options,
          capacity
        ).catch((error) => latchFullFidelityFailure(paths, options, error));
        return latchFullFidelityFailure(paths, options, new Error("Marker reserve exhausted"));
      }
      const persisted = await persistEvent(paths, event, options).catch((error) =>
        latchFullFidelityFailure(paths, options, error)
      );
      return {
        ...persisted,
        fullFidelity: !usage.hasLoss && !(await isFullFidelityLatched(paths)),
      };
    });
  });
}

export async function replaceUnseenWithLoss(
  eventId: string,
  reason: "invalid_payload" | "permanent_rejection",
  options: OutboxOptions = {}
): Promise<EnqueueResult> {
  if (!new Set(["capacity", "invalid_payload", "permanent_rejection"]).has(reason))
    throw new TypeError("Invalid replacement loss reason");
  const paths = await ensureSecureHarnessPaths(options);
  const capacity = resolveCapacity(options);
  return withAdvisoryLock(paths, "global-capacity", async () => {
    const usage = await prepareStorageLocked(paths, options, capacity);
    const original = (await readPendingEventsLocked(paths, options, capacity)).find(
      ({ event }) => event.eventId === eventId
    );
    if (original === undefined) throw new Error("Pending event not found");
    const originalEvent = original.event;
    if (originalEvent.type !== "turn.append" && originalEvent.type !== "turn.retract") {
      throw new Error("Only unseen append or retract events can be replaced with loss");
    }
    const sessionKey = sourceSessionKey(
      originalEvent.host,
      originalEvent.clientInstanceId,
      originalEvent.hostSessionId
    );
    return withAdvisoryLock(paths, sessionLockName(sessionKey), async () => {
      const event = parsePendingEvent(await readPrivateFile(original.path));
      if (
        event.eventId !== eventId ||
        (event.type !== "turn.append" && event.type !== "turn.retract")
      ) {
        throw new Error("Pending event changed before replacement");
      }
      const acknowledged =
        event.type === "turn.retract"
          ? (
              await readSessionStateUnderLock(
                event.host,
                event.clientInstanceId,
                event.hostSessionId,
                paths
              )
            ).acknowledgedMessages[`${event.sourceGeneration}:${event.hostMessageId}`]
          : undefined;
      if (event.type === "turn.retract" && acknowledged === undefined) {
        throw new Error("Cannot create identity-complete loss for an unknown retraction target");
      }
      const role = event.type === "turn.append" ? event.role : acknowledged!.role;
      const contentHash =
        event.type === "turn.append"
          ? (event.chunk?.messageContentHash ?? event.contentHash)
          : acknowledged!.contentHash;
      const hostMessageId = event.hostMessageId;
      const previousAcknowledgementHash = computeAcknowledgementIdentityHash(
        event as unknown as Readonly<Record<string, unknown>>
      );
      const lossBody = {
        eventId: randomUUID(),
        host: event.host,
        hostSessionId: event.hostSessionId,
        clientInstanceId: event.clientInstanceId,
        enqueueSequence: event.enqueueSequence,
        occurredAt: event.occurredAt,
        normalizationVersion: 1 as const,
        type: "sequence.loss" as const,
        sourceGeneration: event.sourceGeneration,
        reason,
        lostEventType: event.type,
        lostHostMessageId: hostMessageId,
        lostRole: role,
        lostContentHash: contentHash,
      };
      const loss = eventWithPayloadHash(lossBody) as Extract<
        HarnessOutboxEvent,
        { type: "sequence.loss" }
      >;
      if (usage.markers + Buffer.byteLength(canonicalJson(loss)) > capacity.markerReserveBytes) {
        try {
          await writeLossAuditWithRepairJournal(paths, loss, options, capacity);
        } catch (error) {
          return latchFullFidelityFailure(paths, options, error);
        }
        return latchFullFidelityFailure(paths, options, new Error("Marker reserve exhausted"));
      }
      await beginEnqueuedSequenceReplacementUnderLock(
        event.host,
        event.clientInstanceId,
        event.hostSessionId,
        event.enqueueSequence,
        previousAcknowledgementHash,
        computeAcknowledgementIdentityHash(loss as unknown as Readonly<Record<string, unknown>>),
        paths,
        options
      );
      const persisted = await persistEvent(paths, loss, options, original.path).catch((error) =>
        recordPersistenceFailure(paths, loss, options, error, capacity, original.path)
      );
      await writeLossAudit(paths, loss, options, capacity).catch((error) =>
        latchFullFidelityFailure(paths, options, error)
      );
      await writeFidelityFailureLatch(paths, "capture_loss", options).catch((error) =>
        latchFullFidelityFailure(paths, options, error)
      );
      return { ...persisted, fullFidelity: false };
    });
  });
}

export async function enqueueSessionStart(
  input: EnqueueSessionStartInput,
  options: OutboxOptions = {}
): Promise<EnqueueResult> {
  validateSourceIdentity({
    host: input.host,
    hostSessionId: input.hostSessionId,
    clientInstanceId: input.clientInstanceId,
    sourceGeneration: input.requestedGeneration ?? 0,
    occurredAt: input.occurredAt,
  });
  const paths = await ensureSecureHarnessPaths(options);
  const capacity = resolveCapacity(options);
  const sessionKey = sourceSessionKey(input.host, input.clientInstanceId, input.hostSessionId);
  return withAdvisoryLock(paths, "global-capacity", async () => {
    const usage = await prepareStorageLocked(paths, options, capacity);
    return withAdvisoryLock(paths, sessionLockName(sessionKey), async () => {
      const enqueueSequence = await recoverNextSequence(
        input.host,
        input.clientInstanceId,
        input.hostSessionId,
        options
      );
      const body = {
        eventId: randomUUID(),
        host: input.host,
        hostSessionId: input.hostSessionId,
        clientInstanceId: input.clientInstanceId,
        enqueueSequence,
        occurredAt: input.occurredAt ?? new Date().toISOString(),
        normalizationVersion: 1 as const,
        type: "session.start" as const,
        ...(input.requestedGeneration === undefined
          ? {}
          : { requestedGeneration: input.requestedGeneration }),
        ...(input.sensitivity === undefined ? {} : { sensitivity: input.sensitivity }),
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      };
      const event = eventWithPayloadHash(body) as Extract<
        HarnessOutboxEvent,
        { type: "session.start" }
      >;
      if (usage.markers + Buffer.byteLength(canonicalJson(event)) > capacity.markerReserveBytes) {
        return latchFullFidelityFailure(paths, options, new Error("Marker reserve exhausted"));
      }
      const persisted = await persistEvent(paths, event, options).catch((error) =>
        latchFullFidelityFailure(paths, options, error)
      );
      return {
        ...persisted,
        fullFidelity: !usage.hasLoss && !(await isFullFidelityLatched(paths)),
      };
    });
  });
}

export async function enqueueTurnRetraction(
  input: EnqueueTurnRetractionInput,
  options: OutboxOptions = {}
): Promise<EnqueueResult> {
  validateSourceIdentity(input);
  if (
    typeof input.hostMessageId !== "string" ||
    input.hostMessageId.length === 0 ||
    Buffer.byteLength(input.hostMessageId, "utf8") > HARNESS_MAX_IDENTITY_BYTES
  ) {
    throw new TypeError("hostMessageId must be a valid non-empty identity");
  }
  if (input.reason !== "superseded" && input.reason !== "branch_removed") {
    throw new TypeError("Invalid retraction reason");
  }
  const paths = await ensureSecureHarnessPaths(options);
  const capacity = resolveCapacity(options);
  const sessionKey = sourceSessionKey(input.host, input.clientInstanceId, input.hostSessionId);
  return withAdvisoryLock(paths, "global-capacity", async () => {
    const usage = await prepareStorageLocked(paths, options, capacity);
    return withAdvisoryLock(paths, sessionLockName(sessionKey), async () => {
      const enqueueSequence = await recoverNextSequence(
        input.host,
        input.clientInstanceId,
        input.hostSessionId,
        options
      );
      const body = {
        eventId: randomUUID(),
        host: input.host,
        hostSessionId: input.hostSessionId,
        clientInstanceId: input.clientInstanceId,
        enqueueSequence,
        occurredAt: input.occurredAt ?? new Date().toISOString(),
        normalizationVersion: 1 as const,
        type: "turn.retract" as const,
        sourceGeneration: input.sourceGeneration,
        hostMessageId: input.hostMessageId,
        reason: input.reason,
      };
      const event = eventWithPayloadHash(body) as Extract<
        HarnessOutboxEvent,
        { type: "turn.retract" }
      >;
      if (usage.normal + Buffer.byteLength(canonicalJson(event)) > capacity.normalBytes) {
        return latchFullFidelityFailure(paths, options, new Error("Normal capacity exhausted"));
      }
      const persisted = await persistEvent(paths, event, options).catch((error) =>
        latchFullFidelityFailure(paths, options, error)
      );
      return {
        ...persisted,
        fullFidelity: !usage.hasLoss && !(await isFullFidelityLatched(paths)),
      };
    });
  });
}

export async function enqueueSessionEnd(
  input: EnqueueSessionEndInput,
  options: OutboxOptions = {}
): Promise<EnqueueResult> {
  validateSourceIdentity(input);
  if (!new Set(["host_end", "host_delete", "inactivity"]).has(input.reason)) {
    throw new TypeError("Invalid session end reason");
  }
  if (!HASH_PATTERN.test(input.finalMessageSetDigest)) {
    throw new TypeError("Invalid finalMessageSetDigest");
  }
  const paths = await ensureSecureHarnessPaths(options);
  const capacity = resolveCapacity(options);
  const sessionKey = sourceSessionKey(input.host, input.clientInstanceId, input.hostSessionId);
  return withAdvisoryLock(paths, "global-capacity", async () => {
    const usage = await prepareStorageLocked(paths, options, capacity);
    return withAdvisoryLock(paths, sessionLockName(sessionKey), async () => {
      const enqueueSequence = await recoverNextSequence(
        input.host,
        input.clientInstanceId,
        input.hostSessionId,
        options
      );
      const maxEnqueueSequence = input.maxEnqueueSequence ?? enqueueSequence - 1;
      const body = {
        eventId: randomUUID(),
        host: input.host,
        hostSessionId: input.hostSessionId,
        clientInstanceId: input.clientInstanceId,
        enqueueSequence,
        occurredAt: input.occurredAt ?? new Date().toISOString(),
        normalizationVersion: 1 as const,
        type: "session.end" as const,
        sourceGeneration: input.sourceGeneration,
        reason: input.reason,
        finalMessageSetDigest: input.finalMessageSetDigest,
        maxEnqueueSequence,
      };
      const event = eventWithPayloadHash(body) as Extract<
        HarnessOutboxEvent,
        { type: "session.end" }
      >;
      if (usage.markers + Buffer.byteLength(canonicalJson(event)) > capacity.markerReserveBytes) {
        return latchFullFidelityFailure(paths, options, new Error("Marker reserve exhausted"));
      }
      const persisted = await persistEvent(paths, event, options).catch((error) =>
        latchFullFidelityFailure(paths, options, error)
      );
      return {
        ...persisted,
        fullFidelity: !usage.hasLoss && !(await isFullFidelityLatched(paths)),
      };
    });
  });
}
