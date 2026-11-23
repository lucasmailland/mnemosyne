/**
 * Tier A parity — POST /events (design.md D3).
 *
 * HTTP characterization contract for the ONE `deps.core` call site in
 * `packages/server/src/routes/events.ts` — `POST /events`'s T14 auto-fact
 * automation (fire-and-forget: `void deps.core.createFact(...).catch(() => {})`).
 * Every other `events.ts` handler (GET list/single, PATCH sensitivity,
 * DELETE archive-stub, POST annotations) never used `deps.core` and is
 * already covered by `unit/events-route.test.ts` — not duplicated here.
 *
 * Written and merged green against the legacy `deps.core.createFact`
 * (`CoreLike`) implementation FIRST (flatten-legacy-dual-core PR13); the
 * port commit in this same PR then swapped the call to
 * `deps.cognitive.remember` (v3 `MnemoCore`, same canonical write path
 * `capture.ts`/`anticipation.ts` already use — PR12) with ZERO changes to
 * any `expect(...)` line below EXCEPT the two explicitly marked "DISCLOSED
 * exception" assertions, which exercise the internal call shape and
 * necessarily change because `createFact(args)` (one options bag,
 * `attribution`/`tags` top-level) and `remember(req, auth)` (two args,
 * the free-form `attribution` bag folded into `metadata`) are genuinely
 * different calling conventions for the same content — the observable HTTP
 * contract (status code, response body) is unchanged, and the automation
 * remains fire-and-forget (its own failure never affects the HTTP response).
 */
import { describe, it, expect, vi } from "vitest";
import bcrypt from "bcrypt";
import { BCRYPT_COST } from "../../auth.js";
import type { ApiKeyLookup } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import { buildMountHarness } from "../_mountHarness.js";
import { mountEvents } from "../../routes/events.js";

const PLAINTEXT_KEY = "mns_live_eventsparitytest000001";
const WS_ID = "00000000-0000-0000-0000-000000000e01";
const ACTOR_ID = "events-key-001";
const USER_ID = "user-events-parity";

async function makeKeyLookup(): Promise<ApiKeyLookup> {
  const keyHash = await bcrypt.hash(PLAINTEXT_KEY, BCRYPT_COST);
  return {
    listActive: async () => [
      { id: ACTOR_ID, keyHash, workspaceId: WS_ID, scopes: [], userId: USER_ID },
    ],
    findByLookupHash: undefined,
    setLookupHash: undefined,
    touch: async () => {},
  } as unknown as ApiKeyLookup;
}

function authed(): Record<string, string> {
  return { authorization: `Bearer ${PLAINTEXT_KEY}`, "content-type": "application/json" };
}

// Fire-and-forget: the route does not await the auto-fact call, so give the
// microtask queue one tick to drain before asserting on it (same `flush()`
// pattern as `webhook-event-coverage.test.ts`).
async function flush(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await Promise.resolve();
}

const CREATED_EVENT = {
  id: "evt-parity-1",
  workspaceId: WS_ID,
  type: "user" as const,
  name: "shipped-wave-a",
  description: "Wave A merged",
  occurredAt: new Date("2026-06-14T00:00:00.000Z"),
  source: "test",
  relatedEntities: [],
  annotations: [],
  createdAt: new Date("2026-06-14T00:00:00.000Z"),
  metadata: {},
};

async function buildApp(
  remember = vi.fn().mockResolvedValue({ id: "mfact_new", kind: "fact", staged: false })
) {
  const deps = {
    cognitive: { remember },
    storage: {
      createEvent: vi.fn().mockResolvedValue(CREATED_EVENT),
    },
    apiKeys: await makeKeyLookup(),
  } as unknown as ServerDeps;
  const app = buildMountHarness(deps, [mountEvents]);
  return { app, remember };
}

const REQUEST_BODY = {
  type: "user",
  name: "shipped-wave-a",
  description: "Wave A merged",
  occurredAt: "2026-06-14T00:00:00.000Z",
  source: "test",
};

describe("Tier A parity: POST /events (T14 auto-fact automation)", () => {
  it("returns 401 with no bearer token", async () => {
    const { app } = await buildApp();
    const res = await app.request("/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(REQUEST_BODY),
    });
    expect(res.status).toBe(401);
  });

  it("returns 201 with the created event and triggers the auto-fact automation", async () => {
    const { app, remember } = await buildApp();
    const res = await app.request("/events", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify(REQUEST_BODY),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; name: string };
    expect(body.id).toBe("evt-parity-1");
    expect(body.name).toBe("shipped-wave-a");

    await flush();
    expect(remember).toHaveBeenCalledTimes(1);
  });

  it("maps event.description/id/name to the store call's content, carrying source/eventId/eventName", async () => {
    const { app, remember } = await buildApp();
    await app.request("/events", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify(REQUEST_BODY),
    });
    await flush();

    // DISCLOSED exception (see file header): pre-port this is `content` +
    // `attribution` (top-level, free-form bag) + `tags` on
    // `createFact(args)`. Post-port the description moves to
    // `remember(req)`'s `content` and the same source/eventId/eventName
    // bag moves into `metadata` — `remember`'s `attribution`/`provenance`
    // concept is a fixed enum, not a free-form bag (same D2 distinction
    // capture.parity.test.ts already documents for this exact class of
    // call-shape change).
    const call = remember.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.content).toBe(CREATED_EVENT.description);
    expect(call.tags).toEqual(["auto:event"]);
    const metadata = call.metadata as Record<string, unknown>;
    expect(metadata.source).toBe("event");
    expect(metadata.eventId).toBe(CREATED_EVENT.id);
    expect(metadata.eventName).toBe(CREATED_EVENT.name);
  });

  it("does not fail the HTTP response when the auto-fact automation rejects", async () => {
    const { app } = await buildApp(vi.fn().mockRejectedValue(new Error("boom")));
    const res = await app.request("/events", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify(REQUEST_BODY),
    });
    expect(res.status).toBe(201);
    await flush();
  });
});
