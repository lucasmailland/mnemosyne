/**
 * APP-062 — forgetting is idempotent. A second `DELETE /forget/:kind/:id` of a
 * row the caller already forgot answered 404, so an agent retrying a forget
 * (memory_forget is annotated idempotent) was told the memory did not exist.
 * It now answers 200 with `alreadyForgotten: true`; a row that does not exist,
 * or sits above the caller's ceiling, is still a 404.
 */
import { describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";
import { createCore } from "@mnemo-ai/core/cognitive";
import { BCRYPT_COST } from "../auth.js";
import type { ApiKeyLookup } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import { mountForget } from "../routes/forget.js";
import { buildMountHarness } from "./_mountHarness.js";

const KEY = "mns_live_forgetidempotent0000001";
const WS = "00000000-0000-0000-0000-000000000622";

async function makeApp(maxSensitivity?: string) {
  const keyHash = await bcrypt.hash(KEY, BCRYPT_COST);
  const apiKeys = {
    listActive: async () => [
      {
        id: "k622",
        keyHash,
        workspaceId: WS,
        scopes: ["memory:read", "memory:write", "memory:delete"],
        ...(maxSensitivity ? { maxSensitivity } : {}),
      },
    ],
    findByLookupHash: undefined,
    setLookupHash: undefined,
    touch: async () => {},
  } as unknown as ApiKeyLookup;
  const storage = new InMemoryStorageAdapter();
  const noop = () => undefined;
  const core = createCore({
    storage: storage as never,
    outbox: { append: async () => undefined } as never,
    logger: { debug: noop, info: noop, warn: noop, error: noop } as never,
    telemetry: {
      startSpan: () => ({ end: noop, setAttribute: noop }),
      histogram: noop,
      counter: noop,
      gauge: noop,
    } as never,
  } as never);
  let calls = 0;
  const deps = {
    apiKeys,
    storage,
    cognitive: {
      forget: (...args: Parameters<typeof core.forget>) => {
        calls++;
        return core.forget(...args);
      },
    },
  } as unknown as ServerDeps;
  return { app: buildMountHarness(deps, [mountForget]), storage, calls: () => calls };
}

const del = (app: Awaited<ReturnType<typeof makeApp>>["app"], path: string) =>
  app.request(path, { method: "DELETE", headers: { authorization: `Bearer ${KEY}` } });

async function aFact(storage: InMemoryStorageAdapter, sensitivity = "internal") {
  return storage.createFact({
    workspaceId: WS,
    scope: "global",
    statement: "forget me",
    subject: "x",
    kind: "other",
    sensitivity,
  } as never);
}

describe("DELETE /forget/:kind/:id — idempotent (APP-062)", () => {
  it("a second forget of the same fact answers 200 alreadyForgotten, without a second forget()", async () => {
    const { app, storage, calls } = await makeApp();
    const fact = await aFact(storage);

    const first = await del(app, `/forget/fact/${fact.id}`);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ forgotten: true });

    const second = await del(app, `/forget/fact/${fact.id}`);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ forgotten: true, alreadyForgotten: true });
    expect(calls()).toBe(1);
  });

  it("the same for another kind (a decision)", async () => {
    const { app, storage } = await makeApp();
    const decision = await storage.createDecision({
      workspaceId: WS,
      title: "use postgres",
      decision: "use postgres",
      rationale: "it is there",
    } as never);
    expect((await del(app, `/forget/decision/${decision.id}`)).status).toBe(200);
    const again = await del(app, `/forget/decision/${decision.id}`);
    expect(again.status).toBe(200);
    expect(((await again.json()) as { alreadyForgotten?: boolean }).alreadyForgotten).toBe(true);
  });

  it("a row that never existed is still a 404", async () => {
    const { app } = await makeApp();
    expect((await del(app, "/forget/fact/00000000-0000-0000-0000-00000000dead")).status).toBe(404);
  });

  it("an already-forgotten row above the caller's ceiling is still a 404", async () => {
    const { app, storage } = await makeApp("public");
    const fact = await aFact(storage, "restricted");
    await storage.archiveFact(fact.id, WS);
    expect((await del(app, `/forget/fact/${fact.id}`)).status).toBe(404);
  });
});
