/**
 * APP-006 and APP-024 (audit 2026-11-22), measured live:
 *  - a key with a `public` ceiling, subscribed to "*", received the plaintext of
 *    a `restricted` fact in its `fact.created` frame, and other callers' recall
 *    hits;
 *  - an event without a workspaceId (federation.conflict) reached every
 *    workspace's subscribers;
 *  - the socket needed the key twice: the HTTP bearer middleware in front of
 *    /memory/ws demanded an Authorization header, and the handler demanded
 *    ?token=, which is the only one the TypeScript SDK sends.
 */
import { describe, expect, it } from "vitest";
import type { MnemoBusEvent } from "@mnemo-ai/types";

import { visibleEventFor, wsTokenOf } from "../../ws.js";

const event = (payload: Record<string, unknown>, channel = "fact.created"): MnemoBusEvent => ({
  channel,
  type: channel,
  payload,
  timestamp: "2026-11-22T00:00:00.000Z",
  traceId: "t",
});

const sub = (ceiling: "public" | "internal" | "confidential" | "restricted") => ({
  channel: "*",
  workspaceId: "ws-1",
  ceiling,
});

describe("visibleEventFor — what a subscriber may receive", () => {
  it("passes an event of its workspace at or below its ceiling unchanged", () => {
    const e = event({ workspaceId: "ws-1", id: "f1", statement: "hello", sensitivity: "internal" });
    expect(visibleEventFor(sub("internal"), e)).toBe(e);
  });

  it("drops an event above the subscriber's ceiling", () => {
    const e = event({ workspaceId: "ws-1", id: "f1", statement: "secret", sensitivity: "restricted" });
    expect(visibleEventFor(sub("public"), e)).toBeNull();
    expect(visibleEventFor(sub("confidential"), e)).toBeNull();
    expect(visibleEventFor(sub("restricted"), e)).toBe(e);
  });

  it("drops an event that names no workspace instead of sending it to every workspace", () => {
    const e = event({ winner: { statement: "x" }, loser: { statement: "y" } }, "federation.conflict");
    expect(visibleEventFor(sub("restricted"), e)).toBeNull();
  });

  it("drops another workspace's event", () => {
    expect(visibleEventFor(sub("restricted"), event({ workspaceId: "ws-2", sensitivity: "public" }))).toBeNull();
  });

  it("removes recall hits above the ceiling and keeps the rest", () => {
    const e = event(
      {
        workspaceId: "ws-1",
        query: "payroll",
        hits: [
          { id: "a", content: "public thing", sensitivity: "public" },
          { id: "b", content: "board payroll 4.1M", sensitivity: "restricted" },
          { id: "c", content: "no tier given" },
        ],
      },
      "recall.hit"
    );
    const seen = visibleEventFor(sub("public"), e);
    const hits = (seen?.payload as { hits: Array<{ id: string }> }).hits;
    expect(hits.map((h) => h.id)).toEqual(["a"]);
    expect(JSON.stringify(seen)).not.toContain("4.1M");
    // The bus event itself is not mutated: other subscribers see their own view.
    expect((e.payload as { hits: unknown[] }).hits).toHaveLength(3);
  });

  it("treats an unknown tier as the most restrictive one", () => {
    const e = event({ workspaceId: "ws-1", sensitivity: "top-secret" });
    expect(visibleEventFor(sub("confidential"), e)).toBeNull();
  });
});

describe("wsTokenOf — one key opens the socket", () => {
  const ctx = (query: string | undefined, header: string | undefined) => ({
    req: {
      query: (k: string) => (k === "token" ? query : undefined),
      header: (k: string) => (k.toLowerCase() === "authorization" ? header : undefined),
    },
  });

  it("takes ?token= alone (the SDK's way)", () => {
    expect(wsTokenOf(ctx("mns_live_abc", undefined) as never)).toBe("mns_live_abc");
  });

  it("takes the Authorization header alone", () => {
    expect(wsTokenOf(ctx(undefined, "Bearer mns_live_abc") as never)).toBe("mns_live_abc");
  });

  it("accepts both when they are the same key", () => {
    expect(wsTokenOf(ctx("mns_live_abc", "Bearer mns_live_abc") as never)).toBe("mns_live_abc");
  });

  it("refuses two different keys: the scopes checked and the identity used must be one key", () => {
    expect(wsTokenOf(ctx("mns_live_abc", "Bearer mns_live_xyz") as never)).toBeNull();
  });

  it("returns null when there is none", () => {
    expect(wsTokenOf(ctx(undefined, undefined) as never)).toBeNull();
  });
});
