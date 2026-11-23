import { canonicalJson, computeTerminalDigestV1, sha256Hex } from "@mnemo-ai/types/harness-runtime";

interface TerminalDigestMember {
  type: "M" | "L";
  hostMessageId: string;
  role: "user" | "assistant";
  contentHash: string;
}

export function computePayloadHash(event: Readonly<Record<string, unknown>>): string {
  const { payloadHash: _payloadHash, ...body } = event;
  assertJsonWireValue(body, new Set());
  const serialized = JSON.stringify(body);
  if (serialized === undefined) throw new TypeError("Unsupported payload value");
  return sha256Hex(canonicalJson(JSON.parse(serialized)));
}

function assertJsonWireValue(value: unknown, ancestors: Set<object>): void {
  const valueType = typeof value;
  if (valueType === "function" || valueType === "symbol" || valueType === "bigint") {
    throw new TypeError(`Unsupported payload value: ${valueType}`);
  }
  if (value === null || valueType !== "object") return;

  const object = value as object;
  if (ancestors.has(object)) throw new TypeError("Cyclic payload value");
  ancestors.add(object);
  for (const child of Object.values(object)) assertJsonWireValue(child, ancestors);
  ancestors.delete(object);
}

export function computeTerminalDigest(members: readonly TerminalDigestMember[]): string {
  return computeTerminalDigestV1(members);
}
