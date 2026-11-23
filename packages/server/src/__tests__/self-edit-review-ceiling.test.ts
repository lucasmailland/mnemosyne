/**
 * Final re-review N1: two more ways a capped caller could act on a row above
 * its ceiling. POST /self/edit addressed a hidden fact or strategy for every
 * action but `replace`, and POST /review/enqueue minted a review for a hidden
 * fact or decision (which /review/:id/resolve could then forget). Both now
 * answer the 404 a missing id gets, byte for byte, and change nothing; a
 * caller whose ceiling admits the row still succeeds.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";
import type { CacheAdapter } from "@mnemo-ai/types";

import type { AuthVariables } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import { toErrorBody } from "../errors.js";
import { mountSelf } from "../routes/self.js";
import { mountReview } from "../routes/review.js";

const WS = "11111111-1111-1111-1111-111111111112";
const MISSING = "00000000-0000-0000-0000-00000000dead";

function makeCache(): CacheAdapter {
  const store = new Map<string, unknown>();
  return {
    async get<T>(key: string): Promise<T | null> {
      return (store.get(key) as T) ?? null;
    },
    async set(key: string, value: unknown): Promise<void> {
      store.set(key, value);
    },
    async incrWithTtl(key: string): Promise<number> {
      const next = ((store.get(key) as number) ?? 0) + 1;
      store.set(key, next);
      return next;
    },
  } as unknown as CacheAdapter;
}

async function makeApp() {
  const storage = new InMemoryStorageAdapter();
  const app = new OpenAPIHono<{ Variables: AuthVariables }>();
  app.use("*", async (c, next) => {
    c.set("workspaceId", WS);
    c.set("apiKeyPrefix", "mns_live_");
    c.set("actorId", "key-a");
    c.set("actorType", "agent");
    c.set("scopes", ["memory:admin"] as ReadonlyArray<string>);
    await next();
  });
  mountSelf(app, { storage, cache: makeCache() } as unknown as ServerDeps);
  mountReview(app, { storage } as unknown as ServerDeps);
  app.onError((err, c) => {
    const { status, body } = toErrorBody(err);
    return c.json(body, status as Parameters<typeof c.json>[1]);
  });
  const post = (path: string, body: Record<string, unknown>) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const fact = await storage.createFact({
    workspaceId: WS,
    statement: "A restricted fact",
    kind: "other",
    subject: "x",
    scope: "global",
    sensitivity: "restricted",
  } as never);
  const strategy = await storage.createStrategy({
    workspaceId: WS,
    trigger: "Secret trigger",
    action: "do",
    sensitivity: "restricted",
  });
  const decision = await storage.createDecision({
    workspaceId: WS,
    title: "Secret way",
    body: "...",
    kind: "decision",
    sensitivity: "restricted",
  });
  const rows = async () =>
    JSON.stringify([
      await storage.getFact(fact.id, WS),
      await storage.getStrategy(strategy.id, WS),
      await storage.listActiveLearningReview({ workspaceId: WS, includeResolved: true, limit: 50 }),
    ]);
  return { post, fact, strategy, decision, rows };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

type Ctx = Awaited<ReturnType<typeof makeApp>>;
const SELF_EDITS: Array<[string, (x: Ctx, id: string) => Record<string, unknown>]> = [
  ["append (fact)", (_x, id) => ({ action: "append", target: id, content: "more" })],
  ["replace (fact)", (_x, id) => ({ action: "replace", target: id, content: "other" })],
  ["strengthen (fact)", (_x, id) => ({ action: "strengthen", target: id })],
  ["weaken (fact)", (_x, id) => ({ action: "weaken", target: id })],
  ["forget (fact)", (_x, id) => ({ action: "forget", target: id })],
  ["strengthen (strategy)", (_x, id) => ({ action: "strengthen", target: `strategy:${id}` })],
  ["forget (strategy)", (_x, id) => ({ action: "forget", target: `strategy:${id}` })],
];

describe("POST /self/edit — a target above the ceiling reads as missing", () => {
  it.each(SELF_EDITS)("%s", async (name, body) => {
    const x = await makeApp();
    const id = name.includes("strategy") ? x.strategy.id : x.fact.id;
    const before = await x.rows();
    const hidden = await x.post("/self/edit", { reason: "r", ...body(x, id) });
    const missing = await x.post("/self/edit", { reason: "r", ...body(x, MISSING) });
    expect(hidden.status).toBe(404);
    expect(missing.status).toBe(404);
    expect((await hidden.text()).split(id).join(MISSING)).toBe(await missing.text());
    expect(await x.rows()).toBe(before);
  });

  it("a caller whose ceiling admits the fact still strengthens it", async () => {
    vi.stubEnv("MNEMO_SENSITIVITY_CEILING", "restricted");
    const x = await makeApp();
    const res = await x.post("/self/edit", {
      reason: "r",
      action: "strengthen",
      target: x.fact.id,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { applied: boolean }).applied).toBe(true);
  });
});

describe("POST /review/enqueue — a target above the ceiling reads as missing", () => {
  it.each([
    ["fact", "factId"],
    ["decision", "decisionId"],
  ] as const)("%s", async (kind, field) => {
    const x = await makeApp();
    const id = kind === "fact" ? x.fact.id : x.decision.id;
    const before = await x.rows();
    const hidden = await x.post("/review/enqueue", { [field]: id, reason: "manual" });
    const missing = await x.post("/review/enqueue", { [field]: MISSING, reason: "manual" });
    expect(hidden.status).toBe(404);
    expect(missing.status).toBe(404);
    expect((await hidden.text()).split(id).join(MISSING)).toBe(await missing.text());
    expect(await x.rows()).toBe(before);
  });

  it("a caller whose ceiling admits the fact still queues it", async () => {
    vi.stubEnv("MNEMO_SENSITIVITY_CEILING", "restricted");
    const x = await makeApp();
    const res = await x.post("/review/enqueue", { factId: x.fact.id, reason: "manual" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { inserted: boolean }).inserted).toBe(true);
  });
});
