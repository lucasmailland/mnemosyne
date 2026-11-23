/**
 * Review round (PRIM-10) — `DELETE /forget/event/:id` answered 409
 * `event_immutable` for any existing event, including one above the caller's
 * read ceiling, while a missing id answered 404: an existence oracle for
 * restricted events. The ceiling is checked first, like `DELETE /events/:id`.
 */
import { describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import { BCRYPT_COST } from "../auth.js";
import type { ApiKeyLookup } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import { mountForget } from "../routes/forget.js";
import { buildMountHarness } from "./_mountHarness.js";

const KEY = "mns_live_forgeteventceiling00001";
const WS = "00000000-0000-0000-0000-000000000521";

async function makeApp(event: Record<string, unknown> | null) {
  const keyHash = await bcrypt.hash(KEY, BCRYPT_COST);
  const apiKeys = {
    listActive: async () => [
      {
        id: "k521",
        keyHash,
        workspaceId: WS,
        scopes: ["memory:read", "memory:write", "memory:delete"],
      },
    ],
    findByLookupHash: undefined,
    setLookupHash: undefined,
    touch: async () => {},
  } as unknown as ApiKeyLookup;
  const forget = vi.fn(async () => {
    throw Object.assign(new Error("events are immutable"), { code: "EVENT_IMMUTABLE" });
  });
  const deps = {
    apiKeys,
    storage: { getEvent: vi.fn(async () => event) },
    cognitive: { forget },
  } as unknown as ServerDeps;
  return { app: buildMountHarness(deps, [mountForget]), forget };
}

async function del(app: Awaited<ReturnType<typeof makeApp>>["app"]) {
  return app.request("/forget/event/evt-1", {
    method: "DELETE",
    headers: { authorization: `Bearer ${KEY}` },
  });
}

describe("DELETE /forget/event/:id — ceiling before the refusal", () => {
  it("answers 404 for an event above the caller's ceiling, without reaching forget()", async () => {
    const { app, forget } = await makeApp({
      id: "evt-1",
      workspaceId: WS,
      sensitivity: "restricted",
    });
    expect((await del(app)).status).toBe(404);
    expect(forget).not.toHaveBeenCalled();
  });

  it("answers 404 for a missing event", async () => {
    const { app } = await makeApp(null);
    expect((await del(app)).status).toBe(404);
  });

  it("answers 409 event_immutable for a readable event", async () => {
    const { app } = await makeApp({ id: "evt-1", workspaceId: WS, sensitivity: "internal" });
    const res = await del(app);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("event_immutable");
  });
});
