import { createHash } from "node:crypto";

export const HARNESS_PROTOCOL_VERSION = 1 as const;
export const HARNESS_CHUNK_VERSION = 1 as const;
export const HARNESS_MAX_BATCH_EVENTS = 100;
export const HARNESS_MAX_BATCH_BYTES = 1024 * 1024;
export const HARNESS_MAX_MESSAGE_BYTES = 64 * 1024;
export const HARNESS_MAX_CHUNKS_PER_MESSAGE = 256;
export const HARNESS_MAX_IDENTITY_BYTES = 512;
export const HARNESS_CLOSE_GRACE_MS = 5_000;
export const HARNESS_MAX_GENERATION = 2_147_483_647;
export const HARNESS_MAX_ENQUEUE_SEQUENCE = Number.MAX_SAFE_INTEGER;

export interface HarnessTurnAppendChunk {
  version: typeof HARNESS_CHUNK_VERSION;
  chunkIndex: number;
  chunkCount: number;
  messageContentHash: string;
}

export interface HarnessTerminalMember {
  type: "M" | "L";
  hostMessageId: string;
  role: "user" | "assistant";
  contentHash: string;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
      throw new TypeError("Canonical JSON supports only safe integer numbers");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  throw new TypeError(`Canonical JSON does not support ${typeof value}`);
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function encodeDigestField(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

export function computeTerminalDigestV1(members: readonly HarnessTerminalMember[]): string {
  const identities = new Set<string>();
  const encoded = members.map((member) => {
    const identity = member.hostMessageId;
    if (Buffer.byteLength(identity, "utf8") > HARNESS_MAX_IDENTITY_BYTES) {
      throw new Error(`Terminal member identity exceeds ${HARNESS_MAX_IDENTITY_BYTES} UTF-8 bytes`);
    }
    if (identities.has(identity)) throw new Error("Duplicate terminal member");
    identities.add(identity);

    return {
      type: Buffer.from(member.type, "utf8"),
      hostMessageId: encodeDigestField(member.hostMessageId),
      member: Buffer.concat([
        Buffer.from(member.type, "utf8"),
        encodeDigestField(member.hostMessageId),
        encodeDigestField(member.role),
        encodeDigestField(member.contentHash),
      ]),
    };
  });

  encoded.sort((left, right) => {
    const typeOrder = Buffer.compare(left.type, right.type);
    return typeOrder === 0 ? Buffer.compare(left.hostMessageId, right.hostMessageId) : typeOrder;
  });

  return sha256Hex(Buffer.concat(encoded.map(({ member }) => member)));
}

export { classifyTurnOrigin, TURN_ORIGINS } from "./session.js";
export type { TurnOrigin } from "./session.js";
