/**
 * Unit tests for POST /reminders — conditionEmbedding population (spec.md
 * Requirement 2 of docs/archive/openspec/tool-promise-remediation).
 *
 * Before this fix, `conditionEmbedding` was never computed at creation, so
 * evaluator.ts's vector-cosine path (Path 1, the most accurate one) could
 * never fire for any reminder — every semantic condition silently fell
 * back to LLM-judgment or FTS-keyword matching only.
 *
 * Same pattern as reasoning-cache-routes.test.ts: minimal OpenAPIHono app
 * with fake auth middleware and mocked storage/llm. No real HTTP socket,
 * no DB.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, it, expect, vi } from "vitest";

import type { AuthVariables } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import type { StorageAdapter, MnemoReminder } from "@mnemo-ai/types";
import { toErrorBody } from "../../errors.js";
import { mountReminders } from "../../routes/reminders.js";

const WORKSPACE_ID = "00000000-0000-0000-0000-000000000001";

function makeApp(
  storageOverrides: Partial<StorageAdapter>,
  llm?: { embed: (text: string, model: string) => Promise<number[]> }
) {
  const app = new OpenAPIHono<{ Variables: AuthVariables }>();

  app.use("*", async (c, next) => {
    c.set("workspaceId", WORKSPACE_ID);
    c.set("apiKeyPrefix", "mns_live_");
    c.set("actorId", "tester");
    c.set("actorType", "user");
    c.set("scopes", [] as ReadonlyArray<string>);
    await next();
  });

  const fakeDeps = {
    storage: storageOverrides as unknown as StorageAdapter,
    core: {} as unknown,
    embedModel: "text-embedding-3-small",
    ...(llm ? { llm } : {}),
  } as unknown as ServerDeps;

  mountReminders(app, fakeDeps);

  app.onError((err, c) => {
    const { status, body } = toErrorBody(err);
    return c.json(body, status as Parameters<typeof c.json>[1]);
  });

  return { request: app.request.bind(app) };
}

function makeStoredReminder(overrides: Partial<MnemoReminder> = {}): MnemoReminder {
  return {
    id: "rem-1",
    workspaceId: WORKSPACE_ID,
    content: "Remind about the contract",
    condition: "when user mentions Acme",
    triggerAt: null,
    status: "pending",
    conditionEmbedding: null,
    triggeredAt: null,
    dismissedAt: null,
    createdByAgentId: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    ...overrides,
  };
}

describe("POST /reminders — conditionEmbedding population", () => {
  it("computes and persists conditionEmbedding when an embedder is configured", async () => {
    const embedVector = [0.1, 0.2, 0.3];
    const createReminder = vi
      .fn()
      .mockImplementation(async (input) =>
        makeStoredReminder({ conditionEmbedding: input.conditionEmbedding ?? null })
      );
    const llm = { embed: vi.fn().mockResolvedValue(embedVector) };

    const { request } = makeApp({ createReminder }, llm);

    const res = await request("/reminders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "Remind about the contract",
        condition: "when user mentions Acme",
      }),
    });

    expect(res.status).toBe(201);
    expect(llm.embed).toHaveBeenCalledWith("when user mentions Acme", "text-embedding-3-small");
    expect(createReminder).toHaveBeenCalledWith(
      expect.objectContaining({ conditionEmbedding: embedVector })
    );
  });

  it("creates the reminder with no conditionEmbedding when no embedder is configured (graceful degrade)", async () => {
    const createReminder = vi.fn().mockImplementation(async () => makeStoredReminder());

    const { request } = makeApp({ createReminder }); // no llm

    const res = await request("/reminders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "Remind about the contract",
        condition: "when user mentions Acme",
      }),
    });

    expect(res.status).toBe(201);
    expect(createReminder).toHaveBeenCalledWith(
      expect.objectContaining({ conditionEmbedding: undefined })
    );
  });

  it("still creates the reminder when the embed call throws (non-fatal)", async () => {
    const createReminder = vi.fn().mockImplementation(async () => makeStoredReminder());
    const llm = { embed: vi.fn().mockRejectedValue(new Error("embedder offline")) };

    const { request } = makeApp({ createReminder }, llm);

    const res = await request("/reminders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "Remind about the contract",
        condition: "when user mentions Acme",
      }),
    });

    expect(res.status).toBe(201);
    expect(createReminder).toHaveBeenCalledWith(
      expect.objectContaining({ conditionEmbedding: undefined })
    );
  });

  it("p45 Slice C: passes resolveProvenance()'s actor triple into createReminder", async () => {
    const createReminder = vi.fn().mockImplementation(async () => makeStoredReminder());

    const { request } = makeApp({ createReminder });

    const res = await request("/reminders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "Remind about the contract",
        condition: "when user mentions Acme",
      }),
    });

    expect(res.status).toBe(201);
    expect(createReminder).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: "key:tester",
        actorType: "user",
        userId: null,
      })
    );
  });
});

describe("POST /reminders — triggerAt keeps zod 4.4's ISO date-time set", () => {
  async function post(triggerAt: string) {
    const createReminder = vi.fn().mockImplementation(async () => makeStoredReminder());
    const { request } = makeApp({ createReminder });
    const res = await request("/reminders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Remind about the contract", triggerAt }),
    });
    return { res, createReminder };
  }

  it.each(["2026-08-01T09:00Z", "2026-08-01T09:00:00Z", "2026-08-01T09:00:00.000Z"])(
    "accepts %s",
    async (triggerAt) => {
      const { res, createReminder } = await post(triggerAt);
      expect(res.status).toBe(201);
      expect(createReminder.mock.calls[0]?.[0].triggerAt).toEqual(new Date(triggerAt));
    }
  );

  it("rejects a value that is not a date-time with 400", async () => {
    const { res, createReminder } = await post("next tuesday");
    expect(res.status).toBe(400);
    expect(createReminder).not.toHaveBeenCalled();
  });
});
