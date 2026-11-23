/// <reference types="node" />
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import type { ActorRef, ManagedSessionProvenance } from "../index.js";
import {
  HARNESS_MAX_BATCH_BYTES,
  HARNESS_MAX_BATCH_EVENTS,
  HARNESS_MAX_IDENTITY_BYTES,
  HARNESS_MAX_MESSAGE_BYTES,
  HARNESS_MAX_GENERATION,
  HARNESS_MAX_ENQUEUE_SEQUENCE,
  HARNESS_PROTOCOL_VERSION,
  canonicalJson,
  computeTerminalDigestV1,
  parseHarnessBatchV1,
  parseHarnessProbeV1,
  sha256Hex,
} from "../index.js";

const baseEvent = {
  eventId: "event-1",
  host: "opencode",
  hostSessionId: "host-session-1",
  clientInstanceId: "client-1",
  enqueueSequence: 1,
  occurredAt: "2000-01-01T00:00:00.000Z",
  normalizationVersion: 1,
} as const;

function withPayloadHash<T extends Record<string, unknown>>(event: T): T & { payloadHash: string } {
  return { ...event, payloadHash: sha256Hex(canonicalJson(event)) };
}

function batch(events: unknown[]) {
  return {
    protocolVersion: 1,
    expectedWorkspaceId: "workspace-1",
    clientInstanceId: "client-1",
    events,
  };
}

const eventVariants = [
  withPayloadHash({
    ...baseEvent,
    type: "session.start",
    sensitivity: "internal",
    metadata: { branch: "main" },
  }),
  withPayloadHash({
    ...baseEvent,
    eventId: "event-2",
    enqueueSequence: 2,
    type: "turn.append",
    sourceGeneration: 0,
    hostMessageId: "message-1",
    role: "user",
    content: "hello",
    contentHash: sha256Hex("hello"),
  }),
  withPayloadHash({
    ...baseEvent,
    eventId: "event-3",
    enqueueSequence: 3,
    type: "turn.retract",
    sourceGeneration: 0,
    hostMessageId: "message-1",
    reason: "superseded",
  }),
  withPayloadHash({
    ...baseEvent,
    eventId: "event-4",
    enqueueSequence: 4,
    type: "sequence.loss",
    sourceGeneration: 0,
    reason: "capacity",
    lostEventType: "turn.append",
    lostHostMessageId: "message-2",
    lostRole: "assistant",
    lostContentHash: sha256Hex("lost"),
  }),
  withPayloadHash({
    ...baseEvent,
    eventId: "event-5",
    enqueueSequence: 5,
    type: "event.cancel",
    sourceGeneration: 0,
    targetEventId: "event-4",
    reason: "terminal_rebuild",
  }),
  withPayloadHash({
    ...baseEvent,
    eventId: "event-6",
    enqueueSequence: 6,
    type: "session.end",
    sourceGeneration: 0,
    reason: "host_end",
    finalMessageSetDigest: sha256Hex("terminal-set"),
    maxEnqueueSequence: 5,
  }),
] as const;

describe("harness v1 wire contract", () => {
  afterEach(() => vi.useRealTimers());

  it("accepts all six strict event variants", () => {
    const parsed = parseHarnessBatchV1(batch([...eventVariants]));

    expect(parsed.protocolVersion).toBe(HARNESS_PROTOCOL_VERSION);
    expect(parsed.events.map((event) => event.type)).toEqual([
      "session.start",
      "turn.append",
      "turn.retract",
      "sequence.loss",
      "event.cancel",
      "session.end",
    ]);
  });

  it("rejects unknown envelope and event keys", () => {
    expect(() => parseHarnessBatchV1({ ...batch([eventVariants[0]]), extra: true })).toThrow();
    expect(() =>
      parseHarnessBatchV1(batch([{ ...eventVariants[1], unexpected: "field" }]))
    ).toThrow();
  });

  it("does not classify malformed non-serializable input as a payload limit error", () => {
    expect(() => parseHarnessBatchV1(undefined)).toThrowError(
      expect.not.objectContaining({ name: "HarnessPayloadLimitError" })
    );
  });

  it("accepts only public or internal automatic transcript sensitivity", () => {
    for (const sensitivity of ["confidential", "restricted"]) {
      const event = withPayloadHash({
        ...baseEvent,
        type: "session.start",
        sensitivity,
      });
      expect(() => parseHarnessBatchV1(batch([event]))).toThrow();
    }
  });

  it("requires event and envelope client instance identities to match", () => {
    const event = withPayloadHash({
      ...baseEvent,
      clientInstanceId: "other-client",
      type: "session.start",
    });

    expect(() => parseHarnessBatchV1(batch([event]))).toThrow();
  });

  it("enforces event count and serialized batch byte limits", () => {
    expect(HARNESS_MAX_BATCH_EVENTS).toBe(100);
    expect(HARNESS_MAX_BATCH_BYTES).toBe(1024 * 1024);
    expect(
      parseHarnessBatchV1(batch(Array.from({ length: 100 }, () => eventVariants[0]))).events
    ).toHaveLength(100);
    expect(() =>
      parseHarnessBatchV1(batch(Array.from({ length: 101 }, () => eventVariants[0])))
    ).toThrow();

    const oversized = withPayloadHash({
      ...baseEvent,
      type: "session.start",
      metadata: { padding: "x".repeat(HARNESS_MAX_BATCH_BYTES) },
    });
    expect(() => parseHarnessBatchV1(batch([oversized]))).toThrow();

    const compact = JSON.stringify(batch([eventVariants[0]]));
    const exactlyAtLimit = `${compact}${" ".repeat(HARNESS_MAX_BATCH_BYTES - compact.length)}`;
    expect(parseHarnessBatchV1(exactlyAtLimit).events).toHaveLength(1);
    expect(() => parseHarnessBatchV1(`${exactlyAtLimit} `)).toThrowError(
      expect.objectContaining({
        name: "HarnessPayloadLimitError",
        limit: "batch",
        maxBytes: HARNESS_MAX_BATCH_BYTES,
      })
    );
  });

  it("enforces the sanitized message limit in UTF-8 bytes", () => {
    expect(HARNESS_MAX_MESSAGE_BYTES).toBe(64 * 1024);
    const content = "é".repeat(HARNESS_MAX_MESSAGE_BYTES / 2);
    const atLimit = withPayloadHash({
      ...baseEvent,
      type: "turn.append",
      sourceGeneration: 0,
      hostMessageId: "message-limit",
      role: "assistant",
      content,
      contentHash: sha256Hex(content),
    });
    expect(parseHarnessBatchV1(batch([atLimit])).events).toHaveLength(1);

    const { payloadHash: _payloadHash, ...atLimitBody } = atLimit;
    const overLimitContent = `${content}x`;
    const overLimit = withPayloadHash({
      ...atLimitBody,
      content: overLimitContent,
      contentHash: sha256Hex(overLimitContent),
    });
    expect(() => parseHarnessBatchV1(batch([overLimit]))).toThrowError(
      expect.objectContaining({
        name: "HarnessPayloadLimitError",
        limit: "message",
        maxBytes: HARNESS_MAX_MESSAGE_BYTES,
      })
    );
  });

  it("bounds every caller-supplied identity by UTF-8 bytes", () => {
    const atLimit = "é".repeat(HARNESS_MAX_IDENTITY_BYTES / 2);
    const overLimit = `${atLimit}x`;
    const append = withPayloadHash({
      ...baseEvent,
      eventId: atLimit,
      hostSessionId: atLimit,
      clientInstanceId: atLimit,
      type: "turn.append",
      sourceGeneration: 0,
      hostMessageId: atLimit,
      supersedesSourceMessageId: atLimit,
      role: "user",
      content: "bounded",
      contentHash: sha256Hex("bounded"),
    });
    expect(
      parseHarnessBatchV1({
        protocolVersion: 1,
        expectedWorkspaceId: atLimit,
        clientInstanceId: atLimit,
        events: [append],
      }).events
    ).toHaveLength(1);

    const { payloadHash: _appendPayloadHash, ...appendBody } = append;
    for (const field of [
      "eventId",
      "hostSessionId",
      "clientInstanceId",
      "hostMessageId",
      "supersedesSourceMessageId",
    ] as const) {
      const invalid = withPayloadHash({ ...appendBody, [field]: overLimit });
      expect(() =>
        parseHarnessBatchV1({
          protocolVersion: 1,
          expectedWorkspaceId: field === "clientInstanceId" ? overLimit : atLimit,
          clientInstanceId: field === "clientInstanceId" ? overLimit : atLimit,
          events: [invalid],
        })
      ).toThrow();
    }
    expect(() =>
      parseHarnessProbeV1({
        protocolVersion: 1,
        expectedWorkspaceId: overLimit,
        clientInstanceId: "client-1",
      })
    ).toThrow();
    expect(() =>
      computeTerminalDigestV1([
        { type: "M", hostMessageId: atLimit, role: "user", contentHash: "a".repeat(64) },
      ])
    ).not.toThrow();
    expect(() =>
      computeTerminalDigestV1([
        { type: "M", hostMessageId: overLimit, role: "user", contentHash: "a".repeat(64) },
      ])
    ).toThrow(/identity/i);
  });

  it("treats future timestamps as structurally valid while retaining ISO datetime validation", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-08T00:00:00.000Z"));
    expect(parseHarnessBatchV1(batch([eventVariants[0]])).events).toHaveLength(1);

    const atBoundary = withPayloadHash({
      ...baseEvent,
      occurredAt: "2026-09-09T00:00:00.000Z",
      type: "session.start",
    });
    expect(parseHarnessBatchV1(batch([atBoundary])).events).toHaveLength(1);

    const future = withPayloadHash({
      ...baseEvent,
      occurredAt: "2026-09-09T00:00:00.001Z",
      type: "session.start",
    });
    expect(parseHarnessBatchV1(batch([future])).events).toHaveLength(1);

    for (const occurredAt of ["2026-09-09T09:00Z", "2026-09-09T09:00+03:00"]) {
      const minutes = withPayloadHash({ ...baseEvent, occurredAt, type: "session.start" });
      expect(parseHarnessBatchV1(batch([minutes])).events).toHaveLength(1);
    }

    const invalid = withPayloadHash({
      ...baseEvent,
      occurredAt: "not-an-iso-datetime",
      type: "session.start",
    });
    expect(() => parseHarnessBatchV1(batch([invalid]))).toThrow();
  });

  it("accepts safe numeric boundaries and rejects non-positive, fractional, unsafe, and overflowing values", () => {
    const maxGeneration = 2_147_483_647;
    const maxSequence = Number.MAX_SAFE_INTEGER;
    expect(HARNESS_MAX_GENERATION).toBe(maxGeneration);
    expect(HARNESS_MAX_ENQUEUE_SEQUENCE).toBe(maxSequence);
    const atBoundary = withPayloadHash({
      ...baseEvent,
      enqueueSequence: maxSequence,
      type: "turn.append",
      sourceGeneration: maxGeneration,
      hostMessageId: "message-boundary",
      role: "user",
      content: "boundary",
      contentHash: sha256Hex("boundary"),
    });
    expect(parseHarnessBatchV1(batch([atBoundary])).events).toHaveLength(1);
    const { payloadHash: _boundaryPayloadHash, ...boundaryBody } = atBoundary;

    for (const [field, value] of [
      ["enqueueSequence", 0],
      ["enqueueSequence", 1.5],
      ["enqueueSequence", maxSequence + 1],
      ["sourceGeneration", maxGeneration + 1],
      ["sourceGeneration", 1.5],
    ] as const) {
      const invalid = { ...boundaryBody, [field]: value, payloadHash: sha256Hex("invalid") };
      expect(() => parseHarnessBatchV1(batch([invalid]))).toThrow();
    }

    const endAtBoundary = withPayloadHash({
      ...baseEvent,
      eventId: "end-boundary",
      enqueueSequence: maxSequence,
      type: "session.end",
      sourceGeneration: maxGeneration,
      reason: "host_end",
      finalMessageSetDigest: sha256Hex("empty"),
      maxEnqueueSequence: maxSequence - 1,
    });
    expect(parseHarnessBatchV1(batch([endAtBoundary])).events).toHaveLength(1);
    const { payloadHash: _endPayloadHash, ...endBoundaryBody } = endAtBoundary;
    const invalidEnd = {
      ...endBoundaryBody,
      maxEnqueueSequence: maxSequence + 1,
      payloadHash: sha256Hex("invalid"),
    };
    expect(() => parseHarnessBatchV1(batch([invalidEnd]))).toThrow();
    expect(() =>
      parseHarnessBatchV1(
        batch([
          {
            ...endBoundaryBody,
            enqueueSequence: 1,
            maxEnqueueSequence: 0,
            payloadHash: sha256Hex("invalid"),
          },
        ])
      )
    ).toThrow();
  });

  it("leaves semantic payload hash mismatches for item-level ingestion rejection", () => {
    expect(
      parseHarnessBatchV1(batch([{ ...eventVariants[1], payloadHash: sha256Hex("different") }]))
        .events
    ).toHaveLength(1);
  });

  it("uses the namespaced actor reference for managed provenance", () => {
    expectTypeOf<ManagedSessionProvenance["actorId"]>().toEqualTypeOf<ActorRef>();
  });

  it("strictly validates probe envelopes", () => {
    expect(
      parseHarnessProbeV1({
        protocolVersion: 1,
        expectedWorkspaceId: "workspace-1",
        clientInstanceId: "client-1",
      })
    ).toEqual({
      protocolVersion: 1,
      expectedWorkspaceId: "workspace-1",
      clientInstanceId: "client-1",
    });
    expect(() =>
      parseHarnessProbeV1({
        protocolVersion: 1,
        expectedWorkspaceId: "workspace-1",
        clientInstanceId: "client-1",
        extra: true,
      })
    ).toThrow();
  });
});

describe("harness v1 canonical hashing", () => {
  it("sorts object keys recursively while preserving array order", () => {
    expect(canonicalJson({ z: 1, a: { y: 2, x: [3, { b: 4, a: 5 }] } })).toBe(
      '{"a":{"x":[3,{"a":5,"b":4}],"y":2},"z":1}'
    );
    expect(sha256Hex("hello")).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
    );
  });

  it("matches fixed live, lost-append, and lost-retraction digest vectors", () => {
    expect(
      computeTerminalDigestV1([{ type: "M", hostMessageId: "m1", role: "user", contentHash: "aa" }])
    ).toBe("8e5e84dab3ea8d49dc3a57a5780112d3298cb5d62dbfe138e2bf54bb2a329efe");
    expect(
      computeTerminalDigestV1([
        { type: "L", hostMessageId: "m2", role: "assistant", contentHash: "bb" },
      ])
    ).toBe("fbe36cd842911e48f7ab8f6dc8aa72b48f4af6242e09bf1294884f28baae1328");
    expect(
      computeTerminalDigestV1([{ type: "L", hostMessageId: "m1", role: "user", contentHash: "aa" }])
    ).toBe("0535f6c8f017d8549a1a3a1f9218df57f6d3b7ec4a453629cd7b4d210425cac1");
    expect(
      computeTerminalDigestV1([
        { type: "M", hostMessageId: "m1", role: "user", contentHash: "aa" },
        { type: "L", hostMessageId: "m2", role: "assistant", contentHash: "bb" },
      ])
    ).toBe("ae8ca4d84eec9e437a48d84b16f30b2c3184ec0a63797f938131767c7be18633");
  });

  it("changes the digest when role or content hash changes", () => {
    expect(
      computeTerminalDigestV1([
        { type: "M", hostMessageId: "m1", role: "assistant", contentHash: "aa" },
      ])
    ).toBe("450129796eb74edb9f435d2d8a6305e7f8f41d4bcc0b01fea80c6b17de07d517");
    expect(
      computeTerminalDigestV1([{ type: "M", hostMessageId: "m1", role: "user", contentHash: "ab" }])
    ).toBe("c94b6b2014714f8c7bd90cdfa31cedb694f0f9c1c4ae8c8c1ca4690cf54c4a99");
  });

  it("sorts members by type byte and encoded host message ID", () => {
    const members = [
      { type: "M" as const, hostMessageId: "aa", role: "user" as const, contentHash: "11" },
      {
        type: "M" as const,
        hostMessageId: "z",
        role: "assistant" as const,
        contentHash: "22",
      },
    ];

    expect(computeTerminalDigestV1(members)).toBe(
      "5cfe9ca0c05b4f96799c3964f7710720bcff14925c4b8f0b93f0f4f22554598d"
    );
    expect(computeTerminalDigestV1([...members].reverse())).toBe(
      "5cfe9ca0c05b4f96799c3964f7710720bcff14925c4b8f0b93f0f4f22554598d"
    );
  });

  it("rejects duplicate terminal members", () => {
    const member = {
      type: "M" as const,
      hostMessageId: "m1",
      role: "user" as const,
      contentHash: "aa",
    };
    expect(() => computeTerminalDigestV1([member, member])).toThrow(/duplicate/i);
    expect(() =>
      computeTerminalDigestV1([
        member,
        { ...member, type: "L", role: "assistant", contentHash: "bb" },
      ])
    ).toThrow(/duplicate/i);
  });
});
