import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
  HARNESS_MAX_BATCH_BYTES,
  HARNESS_MAX_BATCH_EVENTS,
  HARNESS_MAX_MESSAGE_BYTES,
  HARNESS_PROTOCOL_VERSION,
  HarnessPayloadLimitError,
  parseHarnessBatchV1,
  parseHarnessProbeV1,
  type HarnessBatchV1,
  type HarnessEventAck,
  type HarnessIngestionPort,
  type HarnessProbeV1,
} from "@mnemo-ai/types";

import type { AuthVariables } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import { HttpError } from "../errors.js";
import { logger } from "../logging.js";
import { resolveProvenance, resolveTrafficOrigin } from "../provenance.js";
import { resolveCeiling } from "../rbac.js";

const RETRY_AFTER_SECONDS = "60";

type HarnessContext = Context<{ Variables: AuthVariables }>;
type HarnessGate = (input: { workspaceId: string }) => Promise<boolean>;

function unavailable(c: HarnessContext, code: string) {
  c.header("Retry-After", RETRY_AFTER_SECONDS);
  throw new HttpError(503, code, code);
}

async function readJsonBody(c: HarnessContext) {
  const raw = await c.req.text();
  if (Buffer.byteLength(raw, "utf8") > HARNESS_MAX_BATCH_BYTES) {
    throw new HttpError(413, "payload_too_large", "Harness request body exceeds 1 MiB limit");
  }
  try {
    return { raw, value: JSON.parse(raw) as unknown };
  } catch {
    throw new HttpError(422, "invalid_harness_envelope", "Harness request body must be valid JSON");
  }
}

function assertProtocolVersion(value: unknown): void {
  if (
    typeof value === "object" &&
    value !== null &&
    "protocolVersion" in value &&
    (value as { protocolVersion?: unknown }).protocolVersion !== HARNESS_PROTOCOL_VERSION
  ) {
    throw new HttpError(
      422,
      "unsupported_protocol_version",
      `Only harness protocol version ${HARNESS_PROTOCOL_VERSION} is supported`
    );
  }
}

function parseProbe(input: unknown): HarnessProbeV1 {
  assertProtocolVersion(input);
  try {
    return parseHarnessProbeV1(input);
  } catch {
    throw new HttpError(422, "invalid_harness_envelope", "Invalid harness probe envelope");
  }
}

function parseBatch(raw: string, input: unknown): HarnessBatchV1 {
  assertProtocolVersion(input);
  try {
    // The protocol parser receives the original bytes so its byte limit cannot
    // be bypassed by parsing and reserializing JSON first.
    return parseHarnessBatchV1(raw);
  } catch (error) {
    if (error instanceof HarnessPayloadLimitError) {
      throw new HttpError(413, "payload_too_large", error.message);
    }
    throw new HttpError(422, "invalid_harness_envelope", "Invalid harness batch envelope");
  }
}

function assertWorkspace(expectedWorkspaceId: string, workspaceId: string): void {
  if (expectedWorkspaceId !== workspaceId) {
    throw new HttpError(
      409,
      "workspace_mismatch",
      "Harness binding does not match the authenticated workspace"
    );
  }
}

function ingestionPort(deps: ServerDeps): HarnessIngestionPort | null {
  const storage = deps.storage;
  return storage && typeof storage.ingestHarnessEvent === "function"
    ? (storage as HarnessIngestionPort)
    : null;
}

/**
 * Workspace-level drain gate, checked after auth and before any write.
 *
 * This is a fast preflight, not the authority: an admin quiesce can commit
 * between this check and the write, so `HarnessRepository` rechecks the same row
 * transactionally. Checking here keeps a drained workspace from paying for a
 * batch it will only reject, and gives the client one clear reason.
 *
 * An adapter that predates the gate has no method and is treated as open, so a
 * partially upgraded deployment keeps ingesting.
 */
async function workspaceIngestionOpen(deps: ServerDeps, workspaceId: string): Promise<boolean> {
  const gate = deps.storage as { isHarnessIngestionEnabled?: HarnessGate } | undefined;
  if (typeof gate?.isHarnessIngestionEnabled !== "function") return true;
  return gate.isHarnessIngestionEnabled({ workspaceId });
}

function acknowledgementToWire(ack: HarnessEventAck): HarnessEventAck {
  return {
    eventId: ack.eventId,
    status: ack.status,
    retryable: ack.retryable,
    ...(ack.code !== undefined ? { code: ack.code } : {}),
    ...(ack.sessionId !== undefined ? { sessionId: ack.sessionId } : {}),
    ...(ack.effectiveGeneration !== undefined
      ? { effectiveGeneration: ack.effectiveGeneration }
      : {}),
  };
}

export function mountHarness(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  deps: ServerDeps
): void {
  app.post("/harness/v1/probe", async (c) => {
    if (process.env.MNEMO_HARNESS_V1_ENABLED !== "true") {
      return unavailable(c, "harness_protocol_disabled");
    }

    const workspaceId = c.get("workspaceId");
    const { value } = await readJsonBody(c);
    const probe = parseProbe(value);
    assertWorkspace(probe.expectedWorkspaceId, workspaceId);

    if (!ingestionPort(deps)) {
      return c.json({
        protocolVersion: HARNESS_PROTOCOL_VERSION,
        workspaceId,
        available: false,
        code: "harness_storage_unavailable",
      });
    }

    // A quiesced workspace answers the probe rather than failing it: the client
    // learns it is bound to a real server that is simply closed for writes, so it
    // holds its queue instead of quarantining on a transport error.
    if (!(await workspaceIngestionOpen(deps, workspaceId))) {
      return c.json({
        protocolVersion: HARNESS_PROTOCOL_VERSION,
        workspaceId,
        available: false,
        code: "harness_workspace_quiesced",
      });
    }

    return c.json({
      protocolVersion: HARNESS_PROTOCOL_VERSION,
      workspaceId,
      available: true,
      limits: {
        maxBatchEvents: HARNESS_MAX_BATCH_EVENTS,
        maxBatchBytes: HARNESS_MAX_BATCH_BYTES,
        maxMessageBytes: HARNESS_MAX_MESSAGE_BYTES,
      },
    });
  });

  app.post("/harness/v1/events", async (c) => {
    if (process.env.MNEMO_HARNESS_V1_ENABLED !== "true") {
      return unavailable(c, "harness_protocol_disabled");
    }

    const storage = ingestionPort(deps);
    if (!storage) return unavailable(c, "harness_storage_unavailable");

    const workspaceId = c.get("workspaceId");
    // Retryable by design: a drain window is temporary, so the local queue must
    // hold these events and come back rather than read a rejection as permanent.
    if (!(await workspaceIngestionOpen(deps, workspaceId))) {
      return unavailable(c, "harness_workspace_quiesced");
    }

    const { raw, value } = await readJsonBody(c);
    const batch = parseBatch(raw, value);
    assertWorkspace(batch.expectedWorkspaceId, workspaceId);

    const actor = resolveProvenance(c);
    const provenance = Object.freeze({
      ...actor,
      trafficOrigin: resolveTrafficOrigin(c, deps.trafficOrigins),
      sensitivityCeiling: resolveCeiling(c),
    });
    const receivedAt = new Date();
    const acknowledgements = [];
    for (const event of batch.events) {
      try {
        acknowledgements.push(
          acknowledgementToWire(
            await storage.ingestHarnessEvent({ workspaceId, provenance, event, receivedAt })
          )
        );
      } catch {
        logger.error(
          { workspace_id: workspaceId, event_id: event.eventId },
          "harness.event_ingestion_failed"
        );
        acknowledgements.push({
          eventId: event.eventId,
          status: "rejected",
          retryable: true,
          code: "ingestion_failed",
        });
      }
    }

    return c.json({
      protocolVersion: HARNESS_PROTOCOL_VERSION,
      workspaceId,
      acknowledgements,
    });
  });
}
