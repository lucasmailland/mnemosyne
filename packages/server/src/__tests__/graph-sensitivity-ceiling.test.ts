/**
 * GET /graph honours the caller's sensitivity ceiling (triage H3-a), counts
 * included: the real in-memory adapter behind the route, a workspace with
 * internal, confidential and restricted rows, and keys under the default env
 * ceiling (internal) or a raised one (restricted).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import bcrypt from "bcrypt";
import { BCRYPT_COST } from "../auth.js";
import type { ApiKeyLookup } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import type { GraphSnapshot } from "@mnemo-ai/types";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";
import { mountGraph } from "../routes/graph.js";
import { buildMountHarness } from "./_mountHarness.js";

const PLAINTEXT_KEY = "mns_live_graphceilingtest0000001";
const WS_ID = "00000000-0000-0000-0000-000000000902";

async function makeApp() {
  const storage = new InMemoryStorageAdapter();
  const open = await storage.createEntity({ workspaceId: WS_ID, name: "Open", kind: "concept" });
  const secret = await storage.createEntity({
    workspaceId: WS_ID,
    name: "Secret",
    kind: "concept",
    sensitivity: "restricted",
  });
  const conf = await storage.createDecision({
    workspaceId: WS_ID,
    kind: "architecture",
    title: "Conf decision",
    body: "...",
    sensitivity: "confidential",
  });
  for (const fact of ["visible", "hidden"]) {
    await storage.createFact({
      workspaceId: WS_ID,
      scope: "global",
      statement: fact,
      subject: "Open",
      kind: "trait",
      entityId: open.id,
      sensitivity: fact === "hidden" ? "restricted" : "internal",
    });
  }
  await storage.createRelation({
    workspaceId: WS_ID,
    sourceId: open.id,
    sourceType: "entity",
    targetId: secret.id,
    targetType: "entity",
    verb: "related",
  });
  await storage.createRelation({
    workspaceId: WS_ID,
    sourceId: open.id,
    sourceType: "entity",
    targetId: conf.id,
    targetType: "decision",
    verb: "related",
  });

  const keyHash = await bcrypt.hash(PLAINTEXT_KEY, BCRYPT_COST);
  const apiKeys = {
    listActive: async () => [
      { id: "key001", keyHash, workspaceId: WS_ID, scopes: ["memory:read"], plan: "free" },
    ],
    touch: async () => {},
  } as unknown as ApiKeyLookup;
  const app = buildMountHarness({ apiKeys, storage } as unknown as ServerDeps, [mountGraph]);
  return { app, open };
}

async function getGraph(): Promise<{ body: GraphSnapshot; openId: string }> {
  const { app, open } = await makeApp();
  const res = await app.request("/graph?includeSemantic=true", {
    headers: { authorization: `Bearer ${PLAINTEXT_KEY}` },
  });
  expect(res.status).toBe(200);
  return { body: (await res.json()) as GraphSnapshot, openId: open.id };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /graph — sensitivity ceiling", () => {
  it("under the default ceiling, omits confidential and restricted nodes, their edges and hidden facts", async () => {
    const { body, openId } = await getGraph();
    expect(body.nodes.map((n) => n.label)).toEqual(["Open"]);
    expect(body.edges).toEqual([]);
    expect(body.nodes[0]!.factCount).toBe(1);
    expect(body.nodes[0]!.mentionCount).toBe(1);
    expect(body.meta).toEqual({
      entityCount: 1,
      episodeCount: 0,
      decisionCount: 0,
      relationCount: 0,
    });
    expect(body.nodes[0]!.id).toBe(openId);
  });

  it("a caller whose ceiling is restricted sees every node, edge and fact", async () => {
    vi.stubEnv("MNEMO_SENSITIVITY_CEILING", "restricted");
    const { body } = await getGraph();
    expect(body.nodes.map((n) => n.label).sort()).toEqual(["Conf decision", "Open", "Secret"]);
    expect(body.edges).toHaveLength(2);
    expect(body.nodes.find((n) => n.label === "Open")!.factCount).toBe(2);
    expect(body.nodes.find((n) => n.label === "Open")!.mentionCount).toBe(2);
  });
});
