/**
 * APP-024 / plan 2.3 (audit 2026-11-22): the WebSocket works through the REAL
 * app — createApp's whole middleware stack, then createWsHandler mounted the
 * way index.ts mounts it — with one token in `?token=` and no header. The
 * older integration test used an empty `new Hono()`, so the bearer middleware
 * that used to answer 401 before the socket handler never ran there.
 */
import bcrypt from "bcrypt";
import WebSocket from "ws";
import { serve } from "@hono/node-server";
import type { Server as HttpServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEventBus } from "@mnemo-ai/core";
import type { MnemoBusEvent } from "@mnemo-ai/types";

import { createApp } from "../../app.js";
import { createWsHandler } from "../../ws.js";
import type { ApiKeyLookup } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import { makeMockCognitive } from "../helpers/mockCognitive.js";

const KEY = "mns_test_wsrealappkey000000000001";
const WS_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

let server: HttpServer;
let port = 0;
const bus = createEventBus();

beforeAll(async () => {
  const keyHash = await bcrypt.hash(KEY, 4);
  const apiKeys: ApiKeyLookup = {
    async listActive() {
      return [
        {
          id: "key-ws-real",
          keyHash,
          workspaceId: WS_ID,
          scopes: ["memory:read", "memory:subscribe"],
          plan: "free",
        },
      ];
    },
    async touch() {},
  };
  const noopSpan = { setAttribute: () => {}, setStatus: () => {}, end: () => {} };
  const deps = {
    apiKeys,
    embedModel: "text-embedding-3-small",
    cognitive: makeMockCognitive(),
    telemetry: {
      startSpan: () => noopSpan,
      counter: () => {},
      histogram: () => {},
      gauge: () => {},
      shutdown: async () => {},
    },
  } as unknown as ServerDeps;
  const app = createApp({ deps, version: "test" });
  const handler = createWsHandler(app, { bus, apiKeys });
  handler.mount(app);
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0 }, (info) => {
      port = info.port;
      resolve();
    }) as HttpServer;
    handler.injectWebSocket(server);
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const open = (url: string) =>
  new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once("open", () => resolve(ws));
    ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.once("error", reject);
  });

describe("/memory/ws through the real app", () => {
  it("opens with only ?token= and delivers this workspace's events", async () => {
    const ws = await open(`ws://127.0.0.1:${port}/memory/ws?token=${KEY}`);
    try {
      ws.send(JSON.stringify({ subscribe: { channel: "facts.*" } }));
      await new Promise((r) => setTimeout(r, 50));
      const got = new Promise<MnemoBusEvent>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("no event")), 2000);
        ws.once("message", (d) => {
          clearTimeout(t);
          resolve(JSON.parse(d.toString()) as MnemoBusEvent);
        });
      });
      bus.emit({
        channel: "fact.created",
        type: "fact.created",
        payload: { id: "f-1", workspaceId: WS_ID, sensitivity: "internal" },
        timestamp: "2026-11-22T00:00:00.000Z",
        traceId: "t-real-app",
      });
      expect((await got).traceId).toBe("t-real-app");
    } finally {
      ws.close();
    }
  });

  it("refuses a wrong ?token= before upgrading", async () => {
    await expect(
      open(`ws://127.0.0.1:${port}/memory/ws?token=mns_test_notthekey00000000000000`)
    ).rejects.toThrow(/401|1008|closed|HTTP/);
  });
});
