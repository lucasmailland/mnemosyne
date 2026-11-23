/**
 * §35(n) Webhook event coverage (deep re-audit P1-7).
 *
 * Before: dispatchWebhookEvent fired only for session.collapsed + event.recorded.
 * After: fact.created / task.created emit webhook_fire outbox entries at their
 * route emit sites. We assert via the storage spy that the dispatch reaches
 * appendOutbox for a subscribed endpoint. Dispatch is detached (void), so we
 * flush the microtask/macrotask queue before asserting.
 */
import { describe, it, expect, vi } from "vitest";
import bcrypt from "bcrypt";
import { BCRYPT_COST } from "../auth.js";
import type { ApiKeyLookup } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import type { StorageAdapter } from "@mnemo-ai/types";
import { mountTasks } from "../routes/tasks.js";
import { buildMountHarness } from "./_mountHarness.js";

const PLAINTEXT_KEY = "mns_live_webhookcoveragetest001";
const WS_ID = "00000000-0000-0000-0000-000000000021";

async function makeKeyLookup(): Promise<ApiKeyLookup> {
  const keyHash = await bcrypt.hash(PLAINTEXT_KEY, BCRYPT_COST);
  return {
    listActive: async () => [{ id: "key001", keyHash, workspaceId: WS_ID, scopes: [] }],
    findByLookupHash: undefined,
    setLookupHash: undefined,
    touch: async () => {},
  } as unknown as ApiKeyLookup;
}

function authed(extra: Record<string, string> = {}) {
  return { authorization: `Bearer ${PLAINTEXT_KEY}`, "content-type": "application/json", ...extra };
}

function storageWithWebhook(
  appendOutbox: ReturnType<typeof vi.fn>,
  extra: Record<string, unknown> = {}
) {
  return {
    listWebhookEndpoints: async () => [
      { id: "w1", url: "http://hook", events: ["*"], isActive: true, secretHash: "s1" },
    ],
    appendOutbox,
    ...extra,
  } as unknown as StorageAdapter;
}

async function flush() {
  await new Promise((r) => setImmediate(r));
  await Promise.resolve();
}

describe("§35(n) webhook event coverage (P1-7)", () => {
  // flatten-legacy-dual-core PR8: removed "POST /facts dispatches a
  // fact.created webhook_fire" — that route was DELETED in this PR (D2 step
  // 2). The equivalent assertion against its replacement is already covered
  // by `routes/__tests__/remember-plugin-write-hooks.test.ts` (PR7, test #5:
  // "fact.created dispatches a webhook_fire outbox entry via
  // deps.storage.appendOutbox"), which explicitly mirrors this file's former
  // /facts assertion pattern.

  it("POST /tasks dispatches a task.created webhook_fire", async () => {
    const appendOutbox = vi.fn().mockResolvedValue(undefined);
    const NOW = new Date("2026-06-17T00:00:00.000Z");
    const createTask = async () => ({
      id: "t1",
      workspaceId: WS_ID,
      title: "do it",
      status: "pending" as const,
      priority: "medium" as const,
      assignedTo: "agentA",
      subtaskIds: [],
      blockedBy: [],
      relatedFacts: [],
      relatedEntities: [],
      // P120: response schemas project the bitemporal interval.
      validFrom: new Date("2026-01-01T00:00:00.000Z"),
      validTo: null,
      createdAt: NOW,
      updatedAt: NOW,
      metadata: {},
    });
    const deps = {
      core: { recall: async () => [] } as unknown as ServerDeps["core"],
      apiKeys: await makeKeyLookup(),
      embedModel: "text-embedding-3-small",
      storage: storageWithWebhook(appendOutbox, { createTask }),
    } as unknown as ServerDeps;
    const app = buildMountHarness(deps, [mountTasks]);

    const res = await app.request("/tasks", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ title: "do it", assignedTo: "agentA" }),
    });
    expect(res.status).toBe(201);
    await flush();

    expect(appendOutbox).toHaveBeenCalledTimes(1);
    const call = appendOutbox.mock.calls[0]![0] as { payload: { eventType: string } };
    expect(call.payload.eventType).toBe("task.created");
  });
});
