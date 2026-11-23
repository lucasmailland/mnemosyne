import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { OpenAPIHono } from "@hono/zod-openapi";
import {
  HARNESS_MAX_BATCH_BYTES,
  HARNESS_MAX_BATCH_EVENTS,
  HARNESS_MAX_MESSAGE_BYTES,
  canonicalJson,
  sha256Hex,
  type HarnessEvent,
  type HarnessEventAck,
} from "@mnemo-ai/types";

import { createApp } from "../../app.js";
import type { AuthVariables, ApiKeyLookup } from "../../auth.js";
import { BCRYPT_COST } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import { toErrorBody } from "../../errors.js";
import type { IdempotencyStore } from "../../idempotency.js";
import { logger } from "../../logging.js";
import { mountHarness } from "../harness.js";
import bcrypt from "bcrypt";
import {
  InMemoryAccessPolicyStore,
  InMemoryApprovalStore,
  InMemoryStorageAdapter,
} from "@mnemo-ai/types/testing";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const API_KEY = "mns_live_harnessroutetestkey000001";

type EventBody = HarnessEvent extends infer Event
  ? Event extends HarnessEvent
    ? Omit<Event, "payloadHash">
    : never
  : never;

function event<T extends EventBody>(body: T): HarnessEvent {
  return { ...body, payloadHash: sha256Hex(canonicalJson(body)) } as HarnessEvent;
}

function start(eventId: string, enqueueSequence: number): HarnessEvent {
  return event({
    eventId,
    host: "opencode",
    hostSessionId: "host-session",
    clientInstanceId: "client-a",
    enqueueSequence,
    occurredAt: "2026-09-09T00:00:00.000Z",
    normalizationVersion: 1,
    type: "session.start",
  });
}

function envelope(events: HarnessEvent[], expectedWorkspaceId = WORKSPACE_ID) {
  return {
    protocolVersion: 1,
    expectedWorkspaceId,
    clientInstanceId: "client-a",
    events,
  };
}

function routeApp(storage?: ServerDeps["storage"]): Hono {
  const app = new Hono();
  app.onError((error, c) => {
    const { status, body } = toErrorBody(error);
    return c.json(body, status as 401 | 403 | 409 | 413 | 422 | 500 | 503);
  });
  const routes = new OpenAPIHono<{ Variables: AuthVariables }>();
  routes.use("*", async (c, next) => {
    c.set("workspaceId", WORKSPACE_ID);
    c.set("actorId", "key-row-1");
    c.set("actorType", "agent");
    c.set("userId", "user-1");
    c.set("maxSensitivity", "restricted");
    c.set("scopes", ["memory:session"]);
    c.set("apiKeyPrefix", "mns_live_");
    c.set("plan", "pro");
    await next();
  });
  mountHarness(routes, { storage } as unknown as ServerDeps);
  app.route("/", routes);
  return app;
}

function post(app: Hono, path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

let keyHash: string;

beforeAll(async () => {
  keyHash = await bcrypt.hash(API_KEY, BCRYPT_COST);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function authenticatedApp(
  scopes: string[],
  storage?: ServerDeps["storage"],
  overrides: Partial<ServerDeps> = {}
) {
  const apiKeys: ApiKeyLookup = {
    async listActive() {
      return [{ id: "key-row-1", keyHash, workspaceId: WORKSPACE_ID, scopes, plan: "pro" }];
    },
    touch: () => undefined,
  };
  return createApp({
    deps: {
      apiKeys,
      storage,
      embedModel: "test",
      telemetry: {
        startSpan: () => ({ setAttribute: () => {}, setStatus: () => {}, end: () => {} }),
        counter: () => {},
        histogram: () => {},
        gauge: () => {},
        shutdown: async () => {},
      },
      ...overrides,
    } as unknown as ServerDeps,
    version: "test",
  });
}

describe("POST /harness/v1/probe", () => {
  it.each([undefined, "", "false"])(
    "returns authorized 503 harness_protocol_disabled when flag is %s without touching storage",
    async (flag) => {
      if (flag === undefined) vi.stubEnv("MNEMO_HARNESS_V1_ENABLED", undefined);
      else vi.stubEnv("MNEMO_HARNESS_V1_ENABLED", flag);
      const ingestHarnessEvent = vi.fn();

      const response = await post(routeApp({ ingestHarnessEvent } as never), "/harness/v1/probe", {
        protocolVersion: 1,
        expectedWorkspaceId: WORKSPACE_ID,
        clientInstanceId: "client-a",
      });

      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("60");
      expect(await response.json()).toMatchObject({ error: { code: "harness_protocol_disabled" } });
      expect(ingestHarnessEvent).not.toHaveBeenCalled();
    }
  );

  it("reports enabled protocol limits and performs zero writes", async () => {
    vi.stubEnv("MNEMO_HARNESS_V1_ENABLED", "true");
    const ingestHarnessEvent = vi.fn();

    const response = await post(routeApp({ ingestHarnessEvent } as never), "/harness/v1/probe", {
      protocolVersion: 1,
      expectedWorkspaceId: WORKSPACE_ID,
      clientInstanceId: "client-a",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      protocolVersion: 1,
      workspaceId: WORKSPACE_ID,
      available: true,
      limits: {
        maxBatchEvents: HARNESS_MAX_BATCH_EVENTS,
        maxBatchBytes: HARNESS_MAX_BATCH_BYTES,
        maxMessageBytes: HARNESS_MAX_MESSAGE_BYTES,
      },
    });
    expect(ingestHarnessEvent).not.toHaveBeenCalled();
  });

  it("reports unavailable without HarnessIngestionPort and performs zero writes", async () => {
    vi.stubEnv("MNEMO_HARNESS_V1_ENABLED", "true");
    const response = await post(routeApp({} as never), "/harness/v1/probe", {
      protocolVersion: 1,
      expectedWorkspaceId: WORKSPACE_ID,
      clientInstanceId: "client-a",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      protocolVersion: 1,
      workspaceId: WORKSPACE_ID,
      available: false,
      code: "harness_storage_unavailable",
    });
  });

  it("returns exact 422 unsupported_protocol_version", async () => {
    vi.stubEnv("MNEMO_HARNESS_V1_ENABLED", "true");
    const response = await post(
      routeApp({ ingestHarnessEvent: vi.fn() } as never),
      "/harness/v1/probe",
      {
        protocolVersion: 2,
        expectedWorkspaceId: WORKSPACE_ID,
        clientInstanceId: "client-a",
      }
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: { code: "unsupported_protocol_version" },
    });
  });

  it("returns exact 409 workspace_mismatch without selecting the body workspace", async () => {
    vi.stubEnv("MNEMO_HARNESS_V1_ENABLED", "true");
    const ingestHarnessEvent = vi.fn();
    const response = await post(routeApp({ ingestHarnessEvent } as never), "/harness/v1/probe", {
      protocolVersion: 1,
      expectedWorkspaceId: OTHER_WORKSPACE_ID,
      clientInstanceId: "client-a",
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "workspace_mismatch" } });
    expect(ingestHarnessEvent).not.toHaveBeenCalled();
  });
});

describe("POST /harness/v1/events", () => {
  it.each([undefined, "", "false"])(
    "returns authorized 503 harness_protocol_disabled when flag is %s with zero writes",
    async (flag) => {
      if (flag === undefined) vi.stubEnv("MNEMO_HARNESS_V1_ENABLED", undefined);
      else vi.stubEnv("MNEMO_HARNESS_V1_ENABLED", flag);
      const ingestHarnessEvent = vi.fn();
      const response = await post(
        routeApp({ ingestHarnessEvent } as never),
        "/harness/v1/events",
        envelope([start("event-1", 1)])
      );
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("60");
      expect(await response.json()).toMatchObject({ error: { code: "harness_protocol_disabled" } });
      expect(ingestHarnessEvent).not.toHaveBeenCalled();
    }
  );

  it("returns one complete acknowledgement per input event in input order and reconstructs provenance", async () => {
    vi.stubEnv("MNEMO_HARNESS_V1_ENABLED", "true");
    vi.stubEnv("MNEMO_SENSITIVITY_CEILING", "confidential");
    const acknowledgements: HarnessEventAck[] = [
      { eventId: "event-2", status: "rejected", retryable: false, code: "content_hash_mismatch" },
      {
        eventId: "event-1",
        status: "accepted",
        retryable: false,
        sessionId: "session-1",
        effectiveGeneration: 0,
      },
    ];
    const ingestHarnessEvent = vi.fn(async ({ event: input }: { event: HarnessEvent }) => {
      return acknowledgements.find(({ eventId }) => eventId === input.eventId)!;
    });
    const events = [start("event-2", 1), start("event-1", 2)];

    const response = await post(
      routeApp({ ingestHarnessEvent } as never),
      "/harness/v1/events",
      envelope(events)
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      protocolVersion: 1,
      workspaceId: WORKSPACE_ID,
      acknowledgements,
    });
    expect(ingestHarnessEvent).toHaveBeenCalledTimes(2);
    expect(ingestHarnessEvent.mock.calls[0]![0]).toMatchObject({
      workspaceId: WORKSPACE_ID,
      provenance: {
        actorId: "key:key-row-1",
        actorType: "agent",
        userId: "user-1",
        sensitivityCeiling: "confidential",
      },
    });
    expect(ingestHarnessEvent.mock.calls[0]![0].receivedAt).toBeInstanceOf(Date);
  });

  it("uses expectedWorkspaceId only for comparison and returns exact 409 workspace_mismatch", async () => {
    vi.stubEnv("MNEMO_HARNESS_V1_ENABLED", "true");
    const ingestHarnessEvent = vi.fn();

    const response = await post(
      routeApp({ ingestHarnessEvent } as never),
      "/harness/v1/events",
      envelope([start("event-1", 1)], OTHER_WORKSPACE_ID)
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "workspace_mismatch" } });
    expect(ingestHarnessEvent).not.toHaveBeenCalled();
  });

  it("returns exact 422 unsupported_protocol_version", async () => {
    vi.stubEnv("MNEMO_HARNESS_V1_ENABLED", "true");
    const response = await post(
      routeApp({ ingestHarnessEvent: vi.fn() } as never),
      "/harness/v1/events",
      {
        ...envelope([]),
        protocolVersion: 2,
      }
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: { code: "unsupported_protocol_version" },
    });
  });

  it("feeds the raw body to parsing and returns exact 413 payload_too_large by UTF-8 bytes", async () => {
    vi.stubEnv("MNEMO_HARNESS_V1_ENABLED", "true");
    const oversized = JSON.stringify({ padding: "é".repeat(HARNESS_MAX_BATCH_BYTES / 2) });
    expect(Buffer.byteLength(oversized, "utf8")).toBeGreaterThan(HARNESS_MAX_BATCH_BYTES);

    const response = await post(
      routeApp({ ingestHarnessEvent: vi.fn() } as never),
      "/harness/v1/events",
      oversized
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: "payload_too_large" } });
  });

  it("returns exact 413 payload_too_large for one message over 64 KiB in a sub-1 MiB batch", async () => {
    vi.stubEnv("MNEMO_HARNESS_V1_ENABLED", "true");
    const content = "x".repeat(HARNESS_MAX_MESSAGE_BYTES + 1);
    const oversizedMessage = event({
      eventId: "oversized-message",
      host: "opencode",
      hostSessionId: "host-session",
      clientInstanceId: "client-a",
      enqueueSequence: 1,
      occurredAt: "2026-09-09T00:00:00.000Z",
      normalizationVersion: 1,
      type: "turn.append",
      sourceGeneration: 0,
      hostMessageId: "oversized-message",
      role: "user",
      content,
      contentHash: sha256Hex(content),
    });
    const body = JSON.stringify(envelope([oversizedMessage]));
    const ingestHarnessEvent = vi.fn();
    expect(Buffer.byteLength(body, "utf8")).toBeLessThan(HARNESS_MAX_BATCH_BYTES);

    const response = await post(
      routeApp({ ingestHarnessEvent } as never),
      "/harness/v1/events",
      body
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: "payload_too_large" } });
    expect(ingestHarnessEvent).not.toHaveBeenCalled();
  });

  it("keeps malformed envelopes at exact 422 invalid_harness_envelope", async () => {
    vi.stubEnv("MNEMO_HARNESS_V1_ENABLED", "true");
    const ingestHarnessEvent = vi.fn();

    const response = await post(routeApp({ ingestHarnessEvent } as never), "/harness/v1/events", {
      ...envelope([]),
      events: "not-an-array",
    });

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_harness_envelope" } });
    expect(ingestHarnessEvent).not.toHaveBeenCalled();
  });

  it("returns a permanent future_timestamp item rejection and processes its valid sibling", async () => {
    vi.stubEnv("MNEMO_HARNESS_V1_ENABLED", "true");
    const storage = new InMemoryStorageAdapter();
    const future = event({
      eventId: "future-event",
      host: "opencode",
      hostSessionId: "future-host-session",
      clientInstanceId: "client-a",
      enqueueSequence: 1,
      occurredAt: new Date(Date.now() + 25 * 60 * 60 * 1000).toISOString(), // determinism-ok: ingestion timestamp is the caller's wall clock; the assertion never depends on its value
      normalizationVersion: 1,
      type: "session.start",
    });

    const response = await post(
      routeApp(storage),
      "/harness/v1/events",
      envelope([future, start("valid-sibling", 1)])
    );

    expect(response.status).toBe(200);
    expect((await response.json()).acknowledgements).toEqual([
      {
        eventId: "future-event",
        status: "rejected",
        retryable: false,
        code: "future_timestamp",
      },
      expect.objectContaining({
        eventId: "valid-sibling",
        status: "accepted",
        retryable: false,
      }),
    ]);
  });

  it("returns deterministic 503 harness_storage_unavailable with zero writes", async () => {
    vi.stubEnv("MNEMO_HARNESS_V1_ENABLED", "true");
    const response = await post(routeApp({} as never), "/harness/v1/events", envelope([]));
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(await response.json()).toMatchObject({ error: { code: "harness_storage_unavailable" } });
  });

  it("isolates an unexpected item failure and retries that event through storage", async () => {
    vi.stubEnv("MNEMO_HARNESS_V1_ENABLED", "true");
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const events = [start("event-1", 1), start("event-2", 2), start("event-3", 3)];
    let failedOnce = false;
    const ingestHarnessEvent = vi.fn(async ({ event: input }: { event: HarnessEvent }) => {
      if (input.eventId === "event-2" && !failedOnce) {
        failedOnce = true;
        throw new Error("database connection reset");
      }
      return input.eventId === "event-3"
        ? { eventId: input.eventId, status: "rejected" as const, retryable: false, code: "invalid" }
        : { eventId: input.eventId, status: "accepted" as const, retryable: false };
    });
    const app = routeApp({ ingestHarnessEvent } as never);

    const first = await post(app, "/harness/v1/events", envelope(events));
    expect(first.status).toBe(200);
    expect((await first.json()).acknowledgements).toEqual([
      { eventId: "event-1", status: "accepted", retryable: false },
      { eventId: "event-2", status: "rejected", retryable: true, code: "ingestion_failed" },
      { eventId: "event-3", status: "rejected", retryable: false, code: "invalid" },
    ]);

    const retry = await post(app, "/harness/v1/events", envelope(events));
    expect((await retry.json()).acknowledgements).toEqual([
      { eventId: "event-1", status: "accepted", retryable: false },
      { eventId: "event-2", status: "accepted", retryable: false },
      { eventId: "event-3", status: "rejected", retryable: false, code: "invalid" },
    ]);
    expect(ingestHarnessEvent).toHaveBeenCalledTimes(6);
    expect(error).toHaveBeenCalledWith(
      { workspace_id: WORKSPACE_ID, event_id: "event-2" },
      "harness.event_ingestion_failed"
    );
    expect(JSON.stringify(error.mock.calls)).not.toContain("database connection reset");
  });
});

describe("quiesced workspace gate", () => {
  it("reports the probe unavailable once ingestion is disabled, without ingesting", async () => {
    vi.stubEnv("MNEMO_HARNESS_V1_ENABLED", "true");
    const ingestHarnessEvent = vi.fn();
    const isHarnessIngestionEnabled = vi.fn(async () => false);

    const response = await post(
      routeApp({ ingestHarnessEvent, isHarnessIngestionEnabled } as never),
      "/harness/v1/probe",
      { protocolVersion: 1, expectedWorkspaceId: WORKSPACE_ID, clientInstanceId: "client-a" }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      available: false,
      code: "harness_workspace_quiesced",
    });
    expect(isHarnessIngestionEnabled).toHaveBeenCalledWith({ workspaceId: WORKSPACE_ID });
    expect(ingestHarnessEvent).not.toHaveBeenCalled();
  });

  it("refuses events retryably from a quiesced workspace and writes nothing", async () => {
    vi.stubEnv("MNEMO_HARNESS_V1_ENABLED", "true");
    const ingestHarnessEvent = vi.fn();

    const response = await post(
      routeApp({ ingestHarnessEvent, isHarnessIngestionEnabled: async () => false } as never),
      "/harness/v1/events",
      {
        protocolVersion: 1,
        expectedWorkspaceId: WORKSPACE_ID,
        clientInstanceId: "client-a",
        events: [start("event-quiesced", 1)],
      }
    );

    // 503 + Retry-After, never 4xx: the queue must hold its events and come back,
    // not treat a drain window as permanent rejection.
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(await response.json()).toMatchObject({
      error: { code: "harness_workspace_quiesced" },
    });
    expect(ingestHarnessEvent).not.toHaveBeenCalled();
  });

  it("still ingests when the workspace gate is open or the adapter predates it", async () => {
    vi.stubEnv("MNEMO_HARNESS_V1_ENABLED", "true");
    const ack: HarnessEventAck = { eventId: "event-open", status: "accepted", retryable: false };
    const ingestHarnessEvent = vi.fn(async () => ack);

    for (const storage of [
      { ingestHarnessEvent, isHarnessIngestionEnabled: async () => true },
      { ingestHarnessEvent },
    ]) {
      ingestHarnessEvent.mockClear();
      const response = await post(routeApp(storage as never), "/harness/v1/events", {
        protocolVersion: 1,
        expectedWorkspaceId: WORKSPACE_ID,
        clientInstanceId: "client-a",
        events: [start("event-open", 1)],
      });
      expect(response.status).toBe(200);
      expect(ingestHarnessEvent).toHaveBeenCalledOnce();
    }
  });
});

describe("harness authorization ordering", () => {
  it.each(["/harness/v1/probe", "/harness/v1/events"])(
    "%s returns 401 before disabled protocol and missing storage checks",
    async (path) => {
      vi.stubEnv("MNEMO_HARNESS_V1_ENABLED", "false");
      const response = await post(authenticatedApp(["memory:session"]), path, {});
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: { code: "unauthorized" } });
    }
  );

  it.each(["/harness/v1/probe", "/harness/v1/events"])(
    "%s returns 403 before disabled protocol and missing storage checks",
    async (path) => {
      vi.stubEnv("MNEMO_HARNESS_V1_ENABLED", "false");
      const response = await post(
        authenticatedApp(["memory:event"]),
        path,
        {},
        {
          authorization: `Bearer ${API_KEY}`,
        }
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: "INSUFFICIENT_SCOPE" } });
    }
  );

  it("applies the production body limit before authentication", async () => {
    vi.stubEnv("MNEMO_HARNESS_V1_ENABLED", "true");
    const response = await post(
      authenticatedApp(["memory:session"], { ingestHarnessEvent: vi.fn() } as never),
      "/harness/v1/events",
      JSON.stringify({ padding: "x".repeat(HARNESS_MAX_BATCH_BYTES) })
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: "payload_too_large" } });
  });

  it("enforces a runtime RBAC denial before harness storage", async () => {
    vi.stubEnv("MNEMO_HARNESS_V1_ENABLED", "true");
    const accessPolicies = new InMemoryAccessPolicyStore();
    const approvals = new InMemoryApprovalStore();
    await accessPolicies.putPolicy({
      agentId: "key-row-1",
      workspaceId: WORKSPACE_ID,
      readScopes: ["memory:read"],
      writeScopes: ["memory:write"],
      selfEdit: { enabled: false },
      taskScopes: { canCreate: false, canDelegate: false, canDelegateTo: [] },
      limits: {
        maxRecallsPerMinute: 0,
        maxWritesPerMinute: 0,
        maxSessionsConcurrent: 0,
        maxSelfEditsPerSession: 0,
      },
      requireApprovalFor: [],
      federationAccess: "none",
    });
    const ingestHarnessEvent = vi.fn();
    const response = await post(
      authenticatedApp(["memory:session"], { ingestHarnessEvent } as never, {
        accessPolicies,
        approvals,
      }),
      "/harness/v1/events",
      envelope([start("rbac-event", 1)]),
      { authorization: `Bearer ${API_KEY}` }
    );
    expect(response.status).toBe(403);
    expect(ingestHarnessEvent).not.toHaveBeenCalled();
  });
});

describe("harness production middleware boundaries", () => {
  function rejectingIdempotencyStore(): IdempotencyStore & {
    begin: ReturnType<typeof vi.fn>;
    complete: ReturnType<typeof vi.fn>;
    recordPhase: ReturnType<typeof vi.fn>;
    getRecoveryPoint: ReturnType<typeof vi.fn>;
  } {
    return {
      begin: vi.fn(async () => {
        throw new Error("generic idempotency must not run");
      }),
      complete: vi.fn(async () => undefined),
      recordPhase: vi.fn(async () => undefined),
      getRecoveryPoint: vi.fn(async () => null),
    };
  }

  it.each([
    [
      "/harness/v1/probe",
      { protocolVersion: 1, expectedWorkspaceId: WORKSPACE_ID, clientInstanceId: "client-a" },
    ],
    ["/harness/v1/events", envelope([start("event-idempotency", 1)])],
  ])("%s bypasses generic HTTP idempotency even when a key is present", async (path, body) => {
    vi.stubEnv("MNEMO_HARNESS_V1_ENABLED", "true");
    const idempotencyStore = rejectingIdempotencyStore();
    const ingestHarnessEvent = vi.fn(async ({ event: input }: { event: HarnessEvent }) => ({
      eventId: input.eventId,
      status: "accepted" as const,
      retryable: false,
    }));
    const response = await post(
      authenticatedApp(["memory:session"], { ingestHarnessEvent } as never, { idempotencyStore }),
      path,
      body,
      { authorization: `Bearer ${API_KEY}`, "Idempotency-Key": "caller-key" }
    );
    expect(response.status).toBe(200);
    expect(idempotencyStore.begin).not.toHaveBeenCalled();
    expect(idempotencyStore.complete).not.toHaveBeenCalled();
    expect(idempotencyStore.recordPhase).not.toHaveBeenCalled();
    expect(idempotencyStore.getRecoveryPoint).not.toHaveBeenCalled();
  });

  it("does not leave generic idempotency state when the protocol is disabled", async () => {
    vi.stubEnv("MNEMO_HARNESS_V1_ENABLED", "false");
    const idempotencyStore = rejectingIdempotencyStore();
    const response = await post(
      authenticatedApp(["memory:session"], { ingestHarnessEvent: vi.fn() } as never, {
        idempotencyStore,
      }),
      "/harness/v1/events",
      envelope([start("disabled-event", 1)]),
      { authorization: `Bearer ${API_KEY}`, "Idempotency-Key": "disabled-key" }
    );
    expect(response.status).toBe(503);
    expect(idempotencyStore.begin).not.toHaveBeenCalled();
  });

  it.each([
    [
      "/harness/v1/probe",
      { protocolVersion: 1, expectedWorkspaceId: WORKSPACE_ID, clientInstanceId: "client-a" },
      200,
    ],
    ["/harness/v1/events", envelope([]), 503],
  ])(
    "%s creates no generic idempotency state when storage is unavailable",
    async (path, body, status) => {
      vi.stubEnv("MNEMO_HARNESS_V1_ENABLED", "true");
      const idempotencyStore = rejectingIdempotencyStore();
      const response = await post(
        authenticatedApp(["memory:session"], {} as never, { idempotencyStore }),
        path,
        body,
        { authorization: `Bearer ${API_KEY}`, "Idempotency-Key": "unavailable-key" }
      );
      expect(response.status).toBe(status);
      expect(idempotencyStore.begin).not.toHaveBeenCalled();
    }
  );

  it("keeps the generic idempotency bypass scoped to the two exact harness paths", async () => {
    vi.stubEnv("MNEMO_HARNESS_V1_ENABLED", "true");
    const idempotencyStore = rejectingIdempotencyStore();
    const response = await post(
      authenticatedApp(["memory:session"], { ingestHarnessEvent: vi.fn() } as never, {
        idempotencyStore,
      }),
      "/harness/v1/events/extra",
      {},
      { authorization: `Bearer ${API_KEY}`, "Idempotency-Key": "near-match-key" }
    );
    expect(response.status).toBe(500);
    expect(idempotencyStore.begin).toHaveBeenCalledOnce();
  });

  it("lets retryable acknowledgements re-enter the Task 3 ingestion port", async () => {
    vi.stubEnv("MNEMO_HARNESS_V1_ENABLED", "true");
    const idempotencyStore = rejectingIdempotencyStore();
    let attempt = 0;
    const ingestHarnessEvent = vi.fn(async ({ event: input }: { event: HarnessEvent }) => ({
      eventId: input.eventId,
      status: attempt++ === 0 ? ("rejected" as const) : ("accepted" as const),
      retryable: attempt === 1,
      ...(attempt === 1 ? { code: "missing_session_start" } : {}),
    }));
    const app = authenticatedApp(["memory:session"], { ingestHarnessEvent } as never, {
      idempotencyStore,
    });
    const headers = { authorization: `Bearer ${API_KEY}`, "Idempotency-Key": "retry-key" };

    const first = await post(
      app,
      "/harness/v1/events",
      envelope([start("retry-event", 1)]),
      headers
    );
    expect((await first.json()).acknowledgements[0]).toMatchObject({
      status: "rejected",
      retryable: true,
    });
    const retry = await post(
      app,
      "/harness/v1/events",
      envelope([start("retry-event", 1)]),
      headers
    );
    expect((await retry.json()).acknowledgements[0]).toMatchObject({
      status: "accepted",
      retryable: false,
    });
    expect(ingestHarnessEvent).toHaveBeenCalledTimes(2);
    expect(idempotencyStore.begin).not.toHaveBeenCalled();
  });

  it("does not include harness content in structured request logs", async () => {
    vi.stubEnv("MNEMO_HARNESS_V1_ENABLED", "true");
    const info = vi.fn();
    vi.spyOn(logger, "child").mockReturnValue({ info } as never);
    const secret = "harness-content-must-not-be-logged";
    const input = event({
      eventId: "log-event",
      host: "opencode",
      hostSessionId: "host-session",
      clientInstanceId: "client-a",
      enqueueSequence: 1,
      occurredAt: "2026-09-09T00:00:00.000Z",
      normalizationVersion: 1,
      type: "turn.append",
      sourceGeneration: 0,
      hostMessageId: "log-message",
      role: "user",
      content: secret,
      contentHash: sha256Hex(secret),
    });
    const ingestHarnessEvent = vi.fn(async () => ({
      eventId: input.eventId,
      status: "accepted" as const,
      retryable: false,
    }));

    const response = await post(
      authenticatedApp(["memory:session"], { ingestHarnessEvent } as never),
      "/harness/v1/events",
      envelope([input]),
      { authorization: `Bearer ${API_KEY}` }
    );
    expect(response.status).toBe(200);
    expect(JSON.stringify(info.mock.calls)).not.toContain(secret);
  });
});
