/**
 * A hit's graph context and dispute state are built under the caller's
 * sensitivity ceiling: a relation to a hidden row is not counted, and a
 * conflict whose other end is hidden does not make the hit `contested`
 * (GET /conflicts hides that conflict too).
 */
import { describe, it, expect, vi } from "vitest";
import type { AuthContext } from "@mnemo-ai/types";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";

vi.mock("../compositionality.js", () => ({ composeInferences: vi.fn(async () => []) }));

const { recallCold } = await import("../recall-cold.js");

const WS = "ws-ceiling-structures";

async function setup() {
  const storage = new InMemoryStorageAdapter();
  const fact = (statement: string, sensitivity: "internal" | "restricted") =>
    storage.createFact({
      workspaceId: WS,
      scope: "global",
      statement,
      subject: "s",
      kind: "trait",
      sensitivity,
    });
  const hit = await fact("The hit", "internal");
  const peer = await fact("A visible peer", "internal");
  const secret = await fact("A restricted rival", "restricted");
  const relate = (targetId: string, verb: "related" | "conflicts_with") =>
    storage.createRelation({
      workspaceId: WS,
      sourceId: hit.id,
      sourceType: "fact",
      targetId,
      targetType: "fact",
      verb,
    });
  await relate(peer.id, "related");
  await relate(secret.id, "conflicts_with");
  const ctx = {
    storage,
    vector: { search: vi.fn(async () => [{ id: hit.id, score: 1, primitiveKind: "fact" }]) },
    embed: { model: "test", embedSingle: vi.fn(async () => new Float32Array([1, 0])) },
    outbox: { append: vi.fn(async () => undefined) },
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
      fatal() {},
      child() {
        return this;
      },
    },
    telemetry: {
      startSpan: () => ({ end() {}, setAttribute() {} }),
      histogram() {},
      counter() {},
      gauge() {},
    },
    config: {},
  } as unknown as Parameters<typeof recallCold>[0];
  const recall = async (auth: Partial<AuthContext>) =>
    (
      await recallCold(
        ctx,
        { workspaceId: WS, text: "hit", embedding: new Float32Array([1, 0]), limit: 5 },
        { workspaceId: WS, sessionId: "s", ...auth } as AuthContext
      )
    ).hits.find((h) => h.id === hit.id)!;
  return { recall, peer, secret };
}

describe("recallCold — structures under the ceiling", () => {
  it("a capped caller sees no relation to a hidden row and no conflict with one", async () => {
    const { recall, peer } = await setup();
    const hit = await recall({ scopes: ["memory:read"] });
    expect(hit.relations?.map((r) => r.targetId)).toEqual([peer.id]);
    expect(hit.contested).toBe(false);
    expect(hit.status).toBe("active");
  });

  it("a caller whose ceiling admits every tier sees both", async () => {
    const { recall, peer, secret } = await setup();
    const hit = await recall({ scopes: ["memory:admin"], maxSensitivity: "restricted" });
    expect(hit.relations?.map((r) => r.targetId).sort()).toEqual([peer.id, secret.id].sort());
    expect(hit.contested).toBe(true);
  });
});
