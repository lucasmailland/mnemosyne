import { z } from "zod";
import type { Sensitivity } from "./common.js";
import { isoDateTimeInput } from "./datetime.js";
import {
  HARNESS_CHUNK_VERSION,
  HARNESS_MAX_BATCH_BYTES,
  HARNESS_MAX_BATCH_EVENTS,
  HARNESS_MAX_CHUNKS_PER_MESSAGE,
  HARNESS_MAX_ENQUEUE_SEQUENCE,
  HARNESS_MAX_GENERATION,
  HARNESS_MAX_IDENTITY_BYTES,
  HARNESS_MAX_MESSAGE_BYTES,
  HARNESS_PROTOCOL_VERSION,
  canonicalJson,
  sha256Hex,
} from "./harness-runtime.js";
import type { ActorRef, ActorType } from "./provenance.js";

export * from "./harness-runtime.js";

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const NON_EMPTY_STRING = z.string().min(1);
const IDENTITY_STRING = NON_EMPTY_STRING.refine(
  (value) => Buffer.byteLength(value, "utf8") <= HARNESS_MAX_IDENTITY_BYTES,
  `Identity exceeds ${HARNESS_MAX_IDENTITY_BYTES} UTF-8 bytes`
);
const GENERATION = z.number().int().nonnegative().max(HARNESS_MAX_GENERATION);
const ENQUEUE_SEQUENCE = z.number().int().positive().max(HARNESS_MAX_ENQUEUE_SEQUENCE);
const occurredAtSchema = isoDateTimeInput({ offset: true });

export class HarnessPayloadLimitError extends Error {
  override readonly name = "HarnessPayloadLimitError";

  constructor(
    readonly limit: "batch" | "message",
    readonly maxBytes: number,
    readonly actualBytes: number
  ) {
    super(`Harness ${limit} exceeds ${maxBytes} bytes`);
  }
}

const eventBase = {
  eventId: IDENTITY_STRING,
  host: z.enum(["opencode", "claude-code", "codex"]),
  hostSessionId: IDENTITY_STRING,
  clientInstanceId: IDENTITY_STRING,
  enqueueSequence: ENQUEUE_SEQUENCE,
  occurredAt: occurredAtSchema,
  payloadHash: z.string().regex(HASH_PATTERN),
  normalizationVersion: z.literal(1),
};

const harnessTurnAppendChunkSchema = z
  .strictObject({
    version: z.literal(HARNESS_CHUNK_VERSION),
    chunkIndex: z.number().int().nonnegative().max(HARNESS_MAX_CHUNKS_PER_MESSAGE - 1),
    chunkCount: z.number().int().min(2).max(HARNESS_MAX_CHUNKS_PER_MESSAGE),
    messageContentHash: z.string().regex(HASH_PATTERN),
  })
  .refine((chunk) => chunk.chunkIndex < chunk.chunkCount, {
    message: "chunkIndex must be less than chunkCount",
  });

const harnessEventSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...eventBase,
    type: z.literal("session.start"),
    requestedGeneration: GENERATION.optional(),
    sensitivity: z.enum(["public", "internal"]).optional(),
    metadata: z.record(z.string(), z.string()).optional(),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal("turn.append"),
    sourceGeneration: GENERATION,
    hostMessageId: IDENTITY_STRING,
    supersedesSourceMessageId: IDENTITY_STRING.optional(),
    role: z.enum(["user", "assistant"]),
    content: z.string(),
    contentHash: z.string().regex(HASH_PATTERN),
    turnOrigin: z
      .enum([
        "human",
        "agent_message",
        "task_notification",
        "pasted_content",
        "assistant",
        "unknown",
      ])
      .optional(),
    turnOriginEvidence: z.string().max(256).optional(),
    chunk: harnessTurnAppendChunkSchema.optional(),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal("turn.retract"),
    sourceGeneration: GENERATION,
    hostMessageId: IDENTITY_STRING,
    reason: z.enum(["superseded", "branch_removed"]),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal("sequence.loss"),
    sourceGeneration: GENERATION,
    reason: z.enum(["capacity", "invalid_payload", "permanent_rejection"]),
    lostEventType: z.enum(["turn.append", "turn.retract"]),
    lostHostMessageId: IDENTITY_STRING,
    lostRole: z.enum(["user", "assistant"]),
    lostContentHash: z.string().regex(HASH_PATTERN),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal("event.cancel"),
    sourceGeneration: GENERATION,
    targetEventId: IDENTITY_STRING,
    reason: z.enum(["generation_redirect", "terminal_rebuild"]),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal("session.end"),
    sourceGeneration: GENERATION,
    reason: z.enum(["host_end", "host_delete", "inactivity"]),
    finalMessageSetDigest: z.string().regex(HASH_PATTERN),
    maxEnqueueSequence: ENQUEUE_SEQUENCE,
  }),
]);

const harnessBatchV1Schema = z.strictObject({
  protocolVersion: z.literal(HARNESS_PROTOCOL_VERSION),
  expectedWorkspaceId: IDENTITY_STRING,
  clientInstanceId: IDENTITY_STRING,
  events: z.array(harnessEventSchema).max(HARNESS_MAX_BATCH_EVENTS),
});

const harnessProbeV1Schema = z.strictObject({
  protocolVersion: z.literal(HARNESS_PROTOCOL_VERSION),
  expectedWorkspaceId: IDENTITY_STRING,
  clientInstanceId: IDENTITY_STRING,
});

export type HarnessEvent = z.infer<typeof harnessEventSchema>;
export type HarnessBatchV1 = z.infer<typeof harnessBatchV1Schema>;
export type HarnessProbeV1 = z.infer<typeof harnessProbeV1Schema>;

export interface HarnessEventAck {
  eventId: string;
  status: "accepted" | "duplicate" | "rejected";
  retryable: boolean;
  code?: string;
  sessionId?: string;
  effectiveGeneration?: number;
}

export interface HarnessBatchAckV1 {
  protocolVersion: typeof HARNESS_PROTOCOL_VERSION;
  workspaceId: string;
  acknowledgements: HarnessEventAck[];
}

export interface HarnessProbeAckV1 {
  protocolVersion: typeof HARNESS_PROTOCOL_VERSION;
  workspaceId: string;
  available: boolean;
  limits?: {
    maxBatchEvents: number;
    maxBatchBytes: number;
    maxMessageBytes: number;
  };
  code?: string;
}

export interface ManagedSessionProvenance {
  trafficOrigin?: import("./session.js").TrafficOrigin;
  actorId: ActorRef;
  actorType: ActorType;
  userId: string | null;
  sensitivityCeiling: Sensitivity;
}

export type HarnessSemanticErrorCode =
  | "payload_hash_mismatch"
  | "content_hash_mismatch"
  | "future_timestamp"
  | "terminal_sequence_mismatch";

export function computeHarnessPayloadHash(event: HarnessEvent): string {
  const { payloadHash: _payloadHash, ...body } = event;
  return sha256Hex(canonicalJson(body));
}

export function validateHarnessEventSemantics(
  event: HarnessEvent,
  receivedAt: Date
): HarnessSemanticErrorCode | null {
  if (computeHarnessPayloadHash(event) !== event.payloadHash) return "payload_hash_mismatch";
  if (event.type === "turn.append" && sha256Hex(event.content) !== event.contentHash) {
    return "content_hash_mismatch";
  }
  if (event.type === "session.end" && event.enqueueSequence !== event.maxEnqueueSequence + 1) {
    return "terminal_sequence_mismatch";
  }
  if (Date.parse(event.occurredAt) > receivedAt.getTime() + 24 * 60 * 60 * 1000) {
    return "future_timestamp";
  }
  return null;
}

export function parseHarnessBatchV1(input: unknown): HarnessBatchV1 {
  const serialized = typeof input === "string" ? input : JSON.stringify(input);
  if (serialized !== undefined) {
    const serializedBytes = Buffer.byteLength(serialized, "utf8");
    if (serializedBytes > HARNESS_MAX_BATCH_BYTES) {
      throw new HarnessPayloadLimitError("batch", HARNESS_MAX_BATCH_BYTES, serializedBytes);
    }
  }

  const batch = harnessBatchV1Schema.parse(typeof input === "string" ? JSON.parse(input) : input);
  for (const event of batch.events) {
    if (event.clientInstanceId !== batch.clientInstanceId) {
      throw new Error("Event clientInstanceId must match the batch clientInstanceId");
    }
    if (event.type === "turn.append") {
      const messageBytes = Buffer.byteLength(event.content, "utf8");
      if (messageBytes > HARNESS_MAX_MESSAGE_BYTES) {
        throw new HarnessPayloadLimitError("message", HARNESS_MAX_MESSAGE_BYTES, messageBytes);
      }
    }
  }
  return batch;
}

export function parseHarnessProbeV1(input: unknown): HarnessProbeV1 {
  return harnessProbeV1Schema.parse(input);
}
export type ManagedCollapseCommitResult =
  | {
      status: "collapsed";
      operationId: string;
      sessionId: string;
      episodeId: string;
      factIds: string[];
      decisionIds: string[];
      strategyIds: string[];
      rejectedCount: number;
    }
  | {
      status: "archived";
      operationId: string;
      sessionId: string;
      reason: import("./session.js").ManagedArchiveReason;
    };
