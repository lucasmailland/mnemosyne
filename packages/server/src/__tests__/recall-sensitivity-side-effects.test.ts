import { afterEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import { PluginLoader, type MnemoPlugin, type PluginRecallHit } from "@mnemo-ai/plugins";
import type { EventBus } from "@mnemo-ai/core";
import type { MnemoBusEvent, RecallHit, RecallResponse } from "@mnemo-ai/types";
import { createApp } from "../app.js";
import { BCRYPT_COST, type ApiKeyLookup } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import { makeMockCognitive } from "./helpers/mockCognitive.js";

const PLAINTEXT_KEY = "mns_live_recallsensitivity000001";
const WORKSPACE_ID = "00000000-0000-0000-0000-000000000015";

afterEach(() => vi.unstubAllEnvs());

function hit(id: string, sensitivity: RecallHit["sensitivity"]): RecallHit {
  return {
    id,
    primitive: "fact",
    content: `${sensitivity} fact`,
    score: 0.9,
    sensitivity,
    injectionScore: 0,
    provenance: "user_stated",
    origin: "local",
    contested: false,
    validFrom: new Date("2026-01-01T00:00:00.000Z"),
    validTo: null,
    tags: [],
    relations: [],
  };
}

async function makeKeyLookup(
  scopes: string[] = ["memory:read", "memory:admin"],
  maxSensitivity: "public" | "internal" | "confidential" | "restricted" = "public",
): Promise<ApiKeyLookup> {
  const keyHash = await bcrypt.hash(PLAINTEXT_KEY, BCRYPT_COST);
  return {
    listActive: async () => [{
      id: "key001",
      keyHash,
      workspaceId: WORKSPACE_ID,
      scopes,
      maxSensitivity,
    }],
    touch: async () => {},
  } as unknown as ApiKeyLookup;
}

function makeBus() {
  const subscribers: Array<(event: MnemoBusEvent) => void> = [];
  const bus: EventBus = {
    subscribe: vi.fn((_glob, callback) => {
      subscribers.push(callback);
      return () => {};
    }),
    emit(event) {
      for (const subscriber of subscribers) subscriber(event);
    },
    patternCount: vi.fn(() => subscribers.length),
  };
  return bus;
}

async function makeApp(
  plugin: MnemoPlugin,
  hits: RecallHit[],
  key: { scopes?: string[]; maxSensitivity?: "public" | "internal" | "confidential" | "restricted" } = {},
) {
  const pluginLoader = new PluginLoader({ info() {}, warn() {}, error() {} });
  pluginLoader.register(plugin);
  const bus = makeBus();
  const events: MnemoBusEvent[] = [];
  bus.subscribe("agent.*.recall", (event) => events.push(event));
  const response: RecallResponse = {
    hits,
    total: hits.length,
    query: { text: "security", limit: 10, offset: 0 },
    latencyMs: 1,
    fromHotTier: false,
  };
  const deps = {
    core: { recall: vi.fn().mockResolvedValue([]) },
    apiKeys: await makeKeyLookup(key.scopes, key.maxSensitivity),
    cognitive: makeMockCognitive({ recall: vi.fn().mockResolvedValue(response) }),
    pluginLoader,
    bus,
  } as unknown as ServerDeps;
  return { app: createApp({ deps, version: "0.0.0-test" }), events };
}

async function recall(app: ReturnType<typeof createApp>) {
  return app.request("/recall", {
    method: "POST",
    headers: { authorization: `Bearer ${PLAINTEXT_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ query: "security", topK: 10 }),
  });
}

describe("recall sensitivity boundary before side effects", () => {
  it("does not pass core hits above the lowered ceiling to plugins or subscribers", async () => {
    const pluginInput = vi.fn<(hits: PluginRecallHit[]) => PluginRecallHit[]>((hits) => hits);
    const { app, events } = await makeApp({
      id: "capture",
      name: "capture",
      version: "1.0.0",
      onAfterRecall: pluginInput,
    }, [hit("public-core", "public"), hit("confidential-core", "confidential")]);

    const response = await recall(app);

    expect(response.status).toBe(200);
    expect(pluginInput).toHaveBeenCalledOnce();
    expect(pluginInput.mock.calls[0]![0].map((item) => item.id)).toEqual(["public-core"]);
    const recallEvent = events.find((event) => event.type === "recall.hit");
    const eventHits = (recallEvent?.payload as { hits: Array<{ id: string }> }).hits;
    expect(eventHits.map((item) => item.id)).toEqual(["public-core"]);
  });

  it("does not emit plugin-added sensitive hits to recall.hit subscribers", async () => {
    const { app, events } = await makeApp({
      id: "inject-sensitive",
      name: "inject-sensitive",
      version: "1.0.0",
      onAfterRecall: (hits) => [
        ...hits,
        { id: "restricted-plugin", content: "restricted plugin hit", score: 1, sensitivity: "restricted" },
      ],
    }, [hit("public-core", "public")]);

    const response = await recall(app);
    const body = await response.json() as { hits: Array<{ id: string }> };
    const recallEvent = events.find((event) => event.type === "recall.hit");
    const eventHits = (recallEvent?.payload as { hits: Array<{ id: string }> }).hits;

    expect(response.status).toBe(200);
    expect(body.hits.map((item) => item.id)).toEqual(["public-core"]);
    expect(eventHits.map((item) => item.id)).toEqual(["public-core"]);
  });

  it("rejects plugin-added confidential hits when read scope lowers a restricted explicit ceiling", async () => {
    vi.stubEnv("MNEMO_SENSITIVITY_CEILING", "restricted");
    const { app, events } = await makeApp({
      id: "inject-confidential",
      name: "inject-confidential",
      version: "1.0.0",
      onAfterRecall: (hits) => [
        ...hits,
        { id: "confidential-plugin", content: "confidential plugin hit", score: 1, sensitivity: "confidential" },
      ],
    }, [hit("public-core", "public")], {
      scopes: ["memory:read"],
      maxSensitivity: "restricted",
    });

    const response = await recall(app);
    const body = await response.json() as { hits: Array<{ id: string }> };
    const recallEvent = events.find((event) => event.type === "recall.hit");
    const eventHits = (recallEvent?.payload as { hits: Array<{ id: string }> }).hits;

    expect(response.status).toBe(200);
    expect(body.hits.map((item) => item.id)).toEqual(["public-core"]);
    expect(eventHits.map((item) => item.id)).toEqual(["public-core"]);
  });
});
