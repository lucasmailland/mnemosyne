import {
  canonicalJson,
  computeHarnessPayloadHash,
  computeTerminalDigestV1,
  sha256Hex,
  type HarnessEvent,
  type HarnessTerminalMember,
} from "@mnemo-ai/types";
import { describe, expect, it } from "vitest";
import { computePayloadHash, computeTerminalDigest } from "../protocol.js";
import { normalizeVisibleMessage } from "../sanitize.js";

const appendBody = {
  eventId: "event-2",
  host: "opencode",
  hostSessionId: "host-session-1",
  clientInstanceId: "client-1",
  enqueueSequence: 2,
  occurredAt: "2000-01-01T00:00:00.000Z",
  normalizationVersion: 1,
  type: "turn.append",
  sourceGeneration: 0,
  hostMessageId: "message-1",
  role: "user",
  content: "hello",
  contentHash: sha256Hex("hello"),
} as const;

describe("harness protocol hashing", () => {
  it("hashes the canonical sanitized event body without payloadHash", () => {
    const payloadHash = computePayloadHash(appendBody);
    const event = { ...appendBody, payloadHash } as HarnessEvent;

    expect(payloadHash).toBe(sha256Hex(canonicalJson(appendBody)));
    expect(payloadHash).toBe(computeHarnessPayloadHash(event));
    expect(computePayloadHash(event)).toBe(payloadHash);
  });

  it("changes the payload hash when sanitized content changes", () => {
    expect(computePayloadHash({ ...appendBody, content: "[REDACTED]" })).not.toBe(
      computePayloadHash(appendBody)
    );
  });

  it("omits undefined optional object properties like the JSON wire", () => {
    const withUndefined = {
      ...appendBody,
      supersedesSourceMessageId: undefined,
      metadata: { retained: "yes", omitted: undefined },
    };
    const wireBody = JSON.parse(JSON.stringify(withUndefined)) as Record<string, unknown>;

    expect(computePayloadHash(withUndefined)).toBe(computePayloadHash(wireBody));
    expect(computePayloadHash(withUndefined)).toBe(sha256Hex(canonicalJson(wireBody)));
  });

  it.each([
    ["function", { ...appendBody, unsupported: () => undefined }],
    ["symbol", { ...appendBody, unsupported: Symbol("unsupported") }],
    ["bigint", { ...appendBody, unsupported: 1n }],
  ])("rejects unsupported %s payload values", (_name, body) => {
    expect(() => computePayloadHash(body)).toThrow(/unsupported/i);
  });

  it("rejects cyclic payload values", () => {
    const cyclic: Record<string, unknown> = { ...appendBody };
    cyclic.self = cyclic;

    expect(() => computePayloadHash(cyclic)).toThrow(/cyclic/i);
  });

  it("keeps sanitized content and payload hashes compatible with Task 1", () => {
    const secret = "sk-proj-payloadSecretValue123456789";
    const normalized = normalizeVisibleMessage({
      role: "user",
      content: `hello OPENAI_API_KEY=${secret}`,
    });
    const body = { ...appendBody, ...normalized };
    const payloadHash = computePayloadHash(body);
    const event = { ...body, payloadHash } as HarnessEvent;

    expect(normalized.contentHash).toBe(sha256Hex(normalized.content));
    expect(payloadHash).toBe(computeHarnessPayloadHash(event));
    expect(JSON.stringify(event)).not.toContain(secret);
  });

  it("matches the Task 1 terminal digest fixtures", () => {
    const fixtures: Array<[HarnessTerminalMember[], string]> = [
      [
        [{ type: "M", hostMessageId: "m1", role: "user", contentHash: "aa" }],
        "8e5e84dab3ea8d49dc3a57a5780112d3298cb5d62dbfe138e2bf54bb2a329efe",
      ],
      [
        [{ type: "L", hostMessageId: "m2", role: "assistant", contentHash: "bb" }],
        "fbe36cd842911e48f7ab8f6dc8aa72b48f4af6242e09bf1294884f28baae1328",
      ],
      [
        [
          { type: "M", hostMessageId: "m1", role: "user", contentHash: "aa" },
          { type: "L", hostMessageId: "m2", role: "assistant", contentHash: "bb" },
        ],
        "ae8ca4d84eec9e437a48d84b16f30b2c3184ec0a63797f938131767c7be18633",
      ],
    ];

    for (const [members, expected] of fixtures) {
      expect(computeTerminalDigest(members)).toBe(expected);
      expect(computeTerminalDigest(members)).toBe(computeTerminalDigestV1(members));
    }
  });

  it("preserves Task 1 duplicate-member rejection", () => {
    const member = { type: "M", hostMessageId: "m1", role: "user", contentHash: "aa" } as const;

    expect(() => computeTerminalDigest([member, member])).toThrow(/duplicate/i);
  });
});
