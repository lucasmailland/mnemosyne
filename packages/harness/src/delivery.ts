import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { HARNESS_MAX_BATCH_BYTES, HARNESS_PROTOCOL_VERSION } from "@mnemo-ai/types/harness-runtime";
import { readBinding, type HarnessBinding } from "./binding.js";
import {
  atomicWritePrivateFile,
  ensureSecureHarnessPaths,
  fsyncDirectory,
  readPrivateFile,
  type AtomicWriteOptions,
} from "./fs-security.js";
import {
  quarantineUndeliverableEvent,
  readPendingEvents,
  type HarnessOutboxEvent,
} from "./outbox.js";
import {
  acknowledgeEvent,
  sourceSessionKey,
  writeGenerationMapping,
  type AcknowledgedEvent,
} from "./state.js";

const DELIVERY_FILE = "delivery.json";
const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_BATCH_EVENTS = 100;
const BASE_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30 * 60 * 1000;

export interface TransportResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
}

export interface DeliveryTransport {
  post(input: {
    url: string;
    apiKey: string;
    body: string;
    workspaceId: string;
  }): Promise<TransportResponse>;
}

export interface DeliveryState {
  version: 1;
  attempt: number;
  nextAttemptAt?: string;
  /** Set when only a human can unstick delivery. Nothing is sent while present. */
  blocked?: { status: number; at: string };
  /** Proof the server was once reachable, which changes how a 404 is read. */
  probedAt?: string;
}

export interface FlushOptions extends AtomicWriteOptions {
  home?: string;
  apiKey: string;
  transport: DeliveryTransport;
  binding?: HarnessBinding;
  maxAttempts?: number;
  batchEvents?: number;
  now?: () => Date;
  random?: () => number;
  /**
   * Overall bound for one flush. A hook awaits its flush, so a backlog must not
   * turn into an unbounded drain inside the host's hook deadline. Successful
   * batches refund attempts, which is why this is a separate limit. Unset means
   * unbounded, for the explicit drain command.
   */
  budgetMs?: number;
  maxBatches?: number;
}

export interface FlushResult {
  status: "idle" | "delivered" | "retry" | "blocked" | "quarantined" | "deferred" | "unbound";
  delivered: number;
  rejected: number;
  quarantined: number;
  retryAfterMs?: number;
  /** Server session ids learned from accepted acknowledgements, in ack order. */
  sessions?: Array<{
    host: string;
    clientInstanceId: string;
    hostSessionId: string;
    sessionId: string;
    effectiveGeneration?: number;
  }>;
}

/** The queue's own record of what happened last, so backoff survives a restart. */
export async function readDeliveryState(
  options: { home?: string } = {}
): Promise<DeliveryState | null> {
  const paths = await ensureSecureHarnessPaths(options);
  try {
    const parsed: unknown = JSON.parse(await readPrivateFile(join(paths.state, DELIVERY_FILE)));
    return typeof parsed === "object" && parsed !== null && (parsed as DeliveryState).version === 1
      ? (parsed as DeliveryState)
      : null;
  } catch {
    return null;
  }
}

async function writeDeliveryState(
  state: DeliveryState,
  paths: { state: string },
  options: AtomicWriteOptions
): Promise<void> {
  await atomicWritePrivateFile(join(paths.state, DELIVERY_FILE), JSON.stringify(state), options);
  await fsyncDirectory(paths.state);
}

/**
 * Exponential backoff with full jitter, from an injected source.
 *
 * Jitter matters more than the curve: every host that lost the same server comes
 * back at the same moment otherwise, and the retry storm is what keeps it down.
 * The source is injected so the schedule is a test's to decide, not the clock's.
 */
function backoffMs(attempt: number, random: () => number): number {
  const ceiling = Math.min(MAX_RETRY_MS, BASE_RETRY_MS * 2 ** Math.min(attempt, 20));
  return Math.max(BASE_RETRY_MS, Math.floor(ceiling * random()));
}

/** `Retry-After` in seconds, when the server named a time of its own. */
function retryAfterMs(headers: Record<string, string>): number | undefined {
  const raw = headers["retry-after"] ?? headers["Retry-After"];
  if (raw === undefined) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

function toAcknowledged(event: HarnessOutboxEvent): AcknowledgedEvent {
  const { eventId, enqueueSequence } = event;
  switch (event.type) {
    case "turn.append":
      return {
        type: event.type,
        eventId,
        enqueueSequence,
        sourceGeneration: event.sourceGeneration,
        hostMessageId: event.hostMessageId,
        role: event.role,
        contentHash: event.contentHash,
        ...(event.chunk === undefined ? {} : { chunk: event.chunk }),
      };
    case "turn.retract":
      return {
        type: event.type,
        eventId,
        enqueueSequence,
        sourceGeneration: event.sourceGeneration,
        hostMessageId: event.hostMessageId,
        reason: event.reason,
      };
    case "sequence.loss":
      return {
        type: event.type,
        eventId,
        enqueueSequence,
        sourceGeneration: event.sourceGeneration,
        reason: event.reason,
        lostEventType: event.lostEventType,
        lostHostMessageId: event.lostHostMessageId,
        lostRole: event.lostRole,
        lostContentHash: event.lostContentHash,
      };
    case "event.cancel":
      return {
        type: event.type,
        eventId,
        enqueueSequence,
        sourceGeneration: event.sourceGeneration,
        targetEventId: event.targetEventId,
        reason: event.reason,
      };
    case "session.end":
      return {
        type: event.type,
        eventId,
        enqueueSequence,
        sourceGeneration: event.sourceGeneration,
        reason: event.reason,
        finalMessageSetDigest: event.finalMessageSetDigest,
        maxEnqueueSequence: event.maxEnqueueSequence,
      };
    default:
      return {
        type: "session.start",
        eventId,
        enqueueSequence,
        ...(event.requestedGeneration === undefined
          ? {}
          : { requestedGeneration: event.requestedGeneration }),
        ...(event.sensitivity === undefined ? {} : { sensitivity: event.sensitivity }),
        ...(event.metadata === undefined ? {} : { metadata: event.metadata }),
      };
  }
}

interface Acknowledgement {
  eventId: string;
  status: string;
  retryable?: boolean;
  code?: string;
  sessionId?: string;
  effectiveGeneration?: number;
}

/**
 * Read a response only if every part of it is trustworthy.
 *
 * A response that is malformed, on another protocol, for another workspace, or
 * that acknowledges something we did not send proves nothing about what the
 * server actually stored — so it must never be allowed to remove an event from
 * the queue. Returning null means "retry", which is always the safe reading.
 */
function parseAcknowledgements(
  body: string,
  workspaceId: string,
  sentIds: string[]
): Acknowledgement[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const envelope = parsed as {
    protocolVersion?: unknown;
    workspaceId?: unknown;
    acknowledgements?: unknown;
  };
  if (envelope.protocolVersion !== HARNESS_PROTOCOL_VERSION) return null;
  if (envelope.workspaceId !== workspaceId) return null;
  if (!Array.isArray(envelope.acknowledgements)) return null;

  const sent = new Set(sentIds);
  const seen = new Set<string>();
  const acknowledgements: Acknowledgement[] = [];
  for (const raw of envelope.acknowledgements) {
    if (typeof raw !== "object" || raw === null) return null;
    const ack = raw as Acknowledgement;
    if (typeof ack.eventId !== "string" || typeof ack.status !== "string") return null;
    // Unknown or repeated ids mean the server is answering a conversation we are
    // not having; a partial application of that would corrupt the queue.
    if (!sent.has(ack.eventId) || seen.has(ack.eventId)) return null;
    seen.add(ack.eventId);
    acknowledgements.push(ack);
  }
  return acknowledgements;
}

async function quarantine(
  pending: Array<{ path: string }>,
  options: FlushOptions
): Promise<number> {
  let moved = 0;
  for (const entry of pending) {
    // Uses the outbox's own quarantine convention: its recovery scan reads that
    // layout and would throw on anything else left in the directory.
    await quarantineUndeliverableEvent(entry.path, options);
    moved += 1;
  }
  return moved;
}

/**
 * Send what is queued, once.
 *
 * Bounded on purpose: one invocation makes a limited number of attempts and
 * returns. Capture is fail-open, so this never throws into the host and never
 * blocks it — a delivery problem is the queue's problem, and the queue is durable.
 *
 * Ordering on success is deliberate and not interchangeable. The generation
 * mapping is persisted first, because a later event's identity depends on it;
 * then the acknowledgement; and only then is the event file unlinked. A crash at
 * any point leaves work to redo, never work silently lost.
 */
export async function flushOutbox(options: FlushOptions): Promise<FlushResult> {
  const now = options.now ?? (() => new Date());
  const random = options.random ?? Math.random;
  const paths = await ensureSecureHarnessPaths(options);
  const result: FlushResult = { status: "idle", delivered: 0, rejected: 0, quarantined: 0 };

  const binding = options.binding ?? (await readBinding(options));
  if (!binding) return { ...result, status: "unbound" };

  let state: DeliveryState = (await readDeliveryState(options)) ?? { version: 1, attempt: 0 };
  // A rejected credential is not a transient failure. Retrying it can lock the
  // account out, and only a human can supply a working one.
  if (state.blocked) return { ...result, status: "blocked" };
  if (state.nextAttemptAt && Date.parse(state.nextAttemptAt) > now().getTime()) {
    return { ...result, status: "deferred" };
  }

  const url = `${binding.serverUrl}/harness/v1/events`;
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  let batchSize = Math.max(1, options.batchEvents ?? DEFAULT_BATCH_EVENTS);
  let attempts = 0;
  let batchesSent = 0;
  const deadline =
    options.budgetMs === undefined ? Number.POSITIVE_INFINITY : now().getTime() + options.budgetMs;
  const maxBatches = options.maxBatches ?? Number.POSITIVE_INFINITY;

  const defer = async (ms: number): Promise<FlushResult> => {
    state = {
      ...state,
      attempt: state.attempt + 1,
      nextAttemptAt: new Date(now().getTime() + ms).toISOString(),
    };
    await writeDeliveryState(state, paths, options);
    return { ...result, status: "retry", retryAfterMs: ms };
  };

  /** Clear the backoff and record that the server is real. */
  const settle = async (status: FlushResult["status"]): Promise<FlushResult> => {
    state = { ...state, attempt: 0, probedAt: now().toISOString() };
    delete state.nextAttemptAt;
    await writeDeliveryState(state, paths, options);
    return { ...result, status };
  };

  const progressed = () => result.delivered > 0 || result.rejected > 0;

  while (attempts < maxAttempts) {
    if (batchesSent >= maxBatches || now().getTime() >= deadline) {
      // Out of budget, not out of luck: what is left stays queued for the next tick.
      if (progressed()) return settle("delivered");
      return result;
    }
    const allPending = await readPendingEvents(options);
    if (allPending.length === 0) {
      if (progressed()) return settle("delivered");
      if (result.quarantined > 0) return settle("quarantined");
      return result;
    }

    const first = allPending[0]!.event;
    const sameClientPending = allPending.filter(
      (entry) => entry.event.clientInstanceId === first.clientInstanceId
    );
    const pending: typeof sameClientPending = [];
    for (const entry of sameClientPending) {
      if (pending.length >= batchSize) break;
      const candidateEvents = [...pending.map((p) => p.event), entry.event];
      const candidateBody = JSON.stringify({
        protocolVersion: HARNESS_PROTOCOL_VERSION,
        expectedWorkspaceId: binding.workspaceId,
        clientInstanceId: first.clientInstanceId,
        events: candidateEvents,
      });
      if (
        pending.length > 0 &&
        Buffer.byteLength(candidateBody, "utf8") > HARNESS_MAX_BATCH_BYTES
      ) {
        break;
      }
      pending.push(entry);
    }

    attempts += 1;
    batchesSent += 1;

    const body = JSON.stringify({
      protocolVersion: HARNESS_PROTOCOL_VERSION,
      expectedWorkspaceId: binding.workspaceId,
      clientInstanceId: first.clientInstanceId,
      events: pending.map((entry) => entry.event),
    });

    let response: TransportResponse;
    try {
      response = await options.transport.post({
        url,
        apiKey: options.apiKey,
        body,
        workspaceId: binding.workspaceId,
      });
    } catch {
      // Network trouble is the most ordinary thing that can happen here.
      return defer(backoffMs(state.attempt, random));
    }

    if (response.status === 401 || response.status === 403) {
      state = { ...state, blocked: { status: response.status, at: now().toISOString() } };
      await writeDeliveryState(state, paths, options);
      return { ...result, status: "blocked" };
    }

    if (response.status === 409) {
      // The server says this queue belongs to a different binding. Delivering
      // another workspace's conversation is worse than losing it.
      result.quarantined += await quarantine(await readPendingEvents(options), options);
      state = { version: 1, attempt: 0 };
      await writeDeliveryState(state, paths, options);
      return { ...result, status: "quarantined" };
    }

    if (response.status === 413) {
      if (pending.length > 1) {
        // Something in here fits; halve until it does rather than discarding events.
        batchSize = Math.max(1, Math.floor(pending.length / 2));
        continue;
      }
      result.quarantined += await quarantine([pending[0]!], options);
      continue;
    }

    if (response.status === 404 && state.probedAt === undefined) {
      // Never proven to exist: this is a misconfiguration, not a deploy.
      return defer(backoffMs(state.attempt, random));
    }

    if (response.status < 200 || response.status >= 300) {
      return defer(retryAfterMs(response.headers) ?? backoffMs(state.attempt, random));
    }

    const acknowledgements = parseAcknowledgements(
      response.text,
      binding.workspaceId,
      pending.map((entry) => entry.event.eventId)
    );
    if (acknowledgements === null) return defer(backoffMs(state.attempt, random));

    const byId = new Map(acknowledgements.map((ack) => [ack.eventId, ack]));
    let deliveredInBatch = 0;
    for (const entry of pending) {
      const ack = byId.get(entry.event.eventId);
      if (!ack) continue;
      const isAccepted = ack.status === "accepted" || ack.status === "duplicate";
      if (!isAccepted && ack.retryable !== false) continue;

      const event = entry.event;
      // No lock is taken here: acknowledgeEvent and writeGenerationMapping each
      // take the session lock themselves, and wrapping them would deadlock against
      // the outbox's own single-hold rule.
      {
        if (isAccepted) {
          // Mapping first: a later event's identity is derived from it, so it must
          // be durable before this event stops being replayable.
          const requestedGeneration =
            "sourceGeneration" in event && typeof event.sourceGeneration === "number"
              ? event.sourceGeneration
              : event.type === "session.start"
                ? (event.requestedGeneration ?? 0)
                : undefined;
          if (ack.effectiveGeneration !== undefined && requestedGeneration !== undefined) {
            await writeGenerationMapping(
              event.host,
              event.clientInstanceId,
              event.hostSessionId,
              requestedGeneration,
              ack.effectiveGeneration,
              options
            ).catch(() => undefined);
            if (ack.effectiveGeneration !== requestedGeneration) {
              await writeGenerationMapping(
                event.host,
                event.clientInstanceId,
                event.hostSessionId,
                ack.effectiveGeneration,
                ack.effectiveGeneration,
                options
              ).catch(() => undefined);
            }
          }
          if (typeof ack.sessionId === "string" && ack.sessionId.length > 0) {
            (result.sessions ??= []).push({
              host: event.host,
              clientInstanceId: event.clientInstanceId,
              hostSessionId: event.hostSessionId,
              sessionId: ack.sessionId,
              ...(ack.effectiveGeneration === undefined
                ? {}
                : { effectiveGeneration: ack.effectiveGeneration }),
            });
          }
          await acknowledgeEvent(
            event.host,
            event.clientInstanceId,
            event.hostSessionId,
            toAcknowledged(event),
            { ...options, effectiveGeneration: ack.effectiveGeneration }
          );
          result.delivered += 1;
          deliveredInBatch += 1;
        } else {
          result.rejected += 1;
        }
        // Unlinked last: a crash before this replays the event, which the server
        // already deduplicates. A crash after an unlink would lose it outright.
        await unlink(entry.path).catch(() => undefined);
      }
    }
    await fsyncDirectory(paths.outbox);

    // The server answered but left some of what we sent unacknowledged. Sending
    // it again inside the same flush is churn: it just declined. Settle and let
    // the next tick carry it, which is also what keeps one host from hammering.
    if (byId.size < pending.length) {
      return progressed() ? settle("delivered") : settle("retry");
    }
    if (deliveredInBatch > 0) {
      attempts = Math.max(0, attempts - 1);
    }
  }

  if (progressed()) return settle("delivered");
  if (result.quarantined > 0) return settle("quarantined");
  return { ...result, status: "retry" };
}

export async function clearDeliveryBackoff(
  options: { home?: string } & AtomicWriteOptions = {}
): Promise<DeliveryState> {
  const paths = await ensureSecureHarnessPaths(options);
  const existing = (await readDeliveryState(options)) ?? { version: 1 as const, attempt: 0 };
  const next: DeliveryState = {
    version: 1,
    attempt: 0,
    ...(existing.probedAt === undefined ? {} : { probedAt: existing.probedAt }),
  };
  await writeDeliveryState(next, paths, options);
  return next;
}
