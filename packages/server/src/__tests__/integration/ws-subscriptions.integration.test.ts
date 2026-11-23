/**
 * Integration tests — WebSocket subscriptions at /memory/ws
 *
 * These tests use the in-process event bus + a real Hono app to verify
 * end-to-end: connect, subscribe, publish to bus, receive event on WS.
 *
 * NOTE: These are .integration.test.ts so they are excluded from the default
 * vitest run and only run via `pnpm test:integration`.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcrypt";
import { createEventBus } from "@mnemo-ai/core";
import type { MnemoBusEvent } from "@mnemo-ai/types";
import WebSocket from "ws";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { Server as HttpServer } from "node:http";
import { createWsHandler } from "../../ws.js";
import type { ApiKeyLookup } from "../../auth.js";

// ─── Test helpers ─────────────────────────────────────────────────────────────

const BCRYPT_COST = 4; // fast for tests

async function makeApiKeyLookup(
  workspaceId: string,
  plainToken: string,
): Promise<ApiKeyLookup> {
  const keyHash = await bcrypt.hash(plainToken, BCRYPT_COST);
  return {
    async listActive() {
      return [{ id: "key_1", keyHash, workspaceId, scopes: [] as string[], plan: "free" }];
    },
    touch() {},
  };
}

function waitForMessage(ws: WebSocket, timeoutMs = 2000): Promise<MnemoBusEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("ws message timeout")), timeoutMs);
    ws.once("message", (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()) as MnemoBusEvent);
    });
  });
}

function wsConnect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function wsClose(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    ws.once("close", () => resolve());
    ws.close();
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("WebSocket subscriptions (/memory/ws)", () => {
  const TOKEN = "mns_test_abcdefghij12345678901234";
  const WORKSPACE = "ws_test_abc";
  let httpServer: HttpServer;
  let serverPort: number;
  let bus: ReturnType<typeof createEventBus>;

  beforeAll(async () => {
    bus = createEventBus();
    const apiKeys = await makeApiKeyLookup(WORKSPACE, TOKEN);
    const app = new Hono();
    const wsHandler = createWsHandler(app, { bus, apiKeys });
    wsHandler.mount(app);

    await new Promise<void>((resolve) => {
      httpServer = serve({ fetch: app.fetch, port: 0 }, (info) => {
        serverPort = info.port;
        resolve();
      }) as HttpServer;
      wsHandler.injectWebSocket(httpServer);
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  it("rejects connections with no token (close 1008)", async () => {
    const ws = new WebSocket(`ws://localhost:${serverPort}/memory/ws`);
    const code = await new Promise<number>((resolve) => {
      ws.on("close", (c) => resolve(c));
      ws.on("error", () => {}); // suppress unhandled error
    });
    expect(code).toBe(1008);
  });

  it("rejects connections with invalid token (close 1008)", async () => {
    const ws = new WebSocket(
      `ws://localhost:${serverPort}/memory/ws?token=mns_test_invalidtoken12345678901234`,
    );
    const code = await new Promise<number>((resolve) => {
      ws.on("close", (c) => resolve(c));
      ws.on("error", () => {});
    });
    expect(code).toBe(1008);
  });

  it("accepts valid token and receives subscribed events", async () => {
    const ws = await wsConnect(
      `ws://localhost:${serverPort}/memory/ws?token=${TOKEN}`,
    );
    try {
      // Subscribe to facts.*
      ws.send(JSON.stringify({ subscribe: { channel: "facts.*" } }));

      // Give the subscribe message a tick to be processed
      await new Promise((r) => setTimeout(r, 50));

      const event: MnemoBusEvent = {
        channel: "fact.created",
        type: "fact.created",
        payload: { id: "fact_1", workspaceId: WORKSPACE },
        timestamp: new Date().toISOString(), // determinism-ok: throwaway fixture date, not asserted
        traceId: "trace-abc",
      };

      bus.emit(event);

      const received = await waitForMessage(ws);
      expect(received.type).toBe("fact.created");
      expect(received.traceId).toBe("trace-abc");
    } finally {
      await wsClose(ws);
    }
  });

  it("does NOT forward events from another workspace", async () => {
    const ws = await wsConnect(
      `ws://localhost:${serverPort}/memory/ws?token=${TOKEN}`,
    );
    try {
      ws.send(JSON.stringify({ subscribe: { channel: "facts.*" } }));
      await new Promise((r) => setTimeout(r, 50));

      // Emit from a DIFFERENT workspace
      bus.emit({
        channel: "fact.created",
        type: "fact.created",
        payload: { id: "fact_x", workspaceId: "ws_other_xyz" },
        timestamp: new Date().toISOString(), // determinism-ok: throwaway fixture date, not asserted
        traceId: "trace-other",
      });

      // Should NOT receive this event
      const received = await waitForMessage(ws, 300).catch(() => null);
      expect(received).toBeNull();
    } finally {
      await wsClose(ws);
    }
  });

  it("stops receiving events after unsubscribe", async () => {
    const ws = await wsConnect(
      `ws://localhost:${serverPort}/memory/ws?token=${TOKEN}`,
    );
    try {
      ws.send(JSON.stringify({ subscribe: { channel: "facts.*" } }));
      await new Promise((r) => setTimeout(r, 50));

      ws.send(JSON.stringify({ unsubscribe: { channel: "facts.*" } }));
      await new Promise((r) => setTimeout(r, 50));

      bus.emit({
        channel: "fact.created",
        type: "fact.created",
        payload: { id: "fact_2", workspaceId: WORKSPACE },
        timestamp: new Date().toISOString(), // determinism-ok: throwaway fixture date, not asserted
        traceId: "trace-2",
      });

      const received = await waitForMessage(ws, 300).catch(() => null);
      expect(received).toBeNull();
    } finally {
      await wsClose(ws);
    }
  });
});
