/**
 * PRIM-14 (V-5) — a create above the caller's own read ceiling used to answer
 * 201 for decisions, entities, episodes, events and reasoning, and the row
 * could never be read back. Same rule, status and code as POST /remember.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, it, expect, vi } from "vitest";

import type { AuthVariables } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import { toErrorBody } from "../errors.js";
import { mountDecisions } from "../routes/decisions.js";
import { mountEntities } from "../routes/entities.js";
import { mountEpisodes } from "../routes/episodes.js";
import { mountEvents } from "../routes/events.js";
import { mountReasoning } from "../routes/reasoning.js";
import { mountSkills } from "../routes/skills.js";
import { mountStrategies } from "../routes/strategies.js";
import { mountTasks } from "../routes/tasks.js";
import { mountWorkflows } from "../routes/workflows.js";

const WS = "00000000-0000-0000-0000-cc0000000001";

const CASES: ReadonlyArray<{
  name: string;
  path: string;
  mount: (app: OpenAPIHono<{ Variables: AuthVariables }>, deps: ServerDeps) => void;
  create: string;
  body: Record<string, unknown>;
}> = [
  {
    name: "decision",
    path: "/decisions",
    mount: mountDecisions,
    create: "createDecision",
    body: { kind: "decision", title: "t", body: "b" },
  },
  {
    name: "entity",
    path: "/entities",
    mount: mountEntities,
    create: "createEntity",
    body: { name: "Acme", kind: "organization" },
  },
  {
    name: "episode",
    path: "/episodes",
    mount: mountEpisodes,
    create: "createEpisode",
    body: { title: "t", narrative: "n" },
  },
  {
    name: "event",
    path: "/events",
    mount: mountEvents,
    create: "createEvent",
    body: {
      type: "user",
      name: "n",
      description: "d",
      occurredAt: "2026-08-01T00:00:00.000Z",
      source: "test",
    },
  },
  {
    name: "reasoning",
    path: "/reasoning",
    mount: mountReasoning,
    create: "createReasoning",
    body: {
      question: "q",
      chain: [{ step: 1, reasoning: "x" }],
      conclusion: "c",
    },
  },
  {
    name: "skill",
    path: "/skills",
    mount: mountSkills,
    create: "createSkill",
    body: { name: "s", promptTemplate: "p" },
  },
  {
    name: "strategy",
    path: "/strategies",
    mount: mountStrategies,
    create: "createStrategy",
    body: { trigger: "t", action: "a" },
  },
  {
    name: "task",
    path: "/tasks",
    mount: mountTasks,
    create: "createTask",
    body: { title: "t", assignedTo: "agent" },
  },
  {
    name: "workflow",
    path: "/workflows",
    mount: mountWorkflows,
    create: "createWorkflow",
    body: { name: "w", steps: [{ order: 1, action: "a", expectedDurationMs: 0 }] },
  },
];

function makeApp(
  mount: (app: OpenAPIHono<{ Variables: AuthVariables }>, deps: ServerDeps) => void,
  create: string,
  maxSensitivity: "public" | "internal" | "confidential" | "restricted"
) {
  const app = new OpenAPIHono<{ Variables: AuthVariables }>();
  app.use("*", async (c, next) => {
    c.set("workspaceId", WS);
    c.set("apiKeyPrefix", "mns_live_");
    c.set("actorId", "k");
    c.set("actorType", "user");
    c.set("scopes", ["memory:write"] as ReadonlyArray<string>);
    c.set("userId", null as never);
    c.set("maxSensitivity", maxSensitivity);
    await next();
  });
  const createFn = vi.fn().mockRejectedValue(new Error("stop-after-ceiling-check"));
  mount(app, {
    storage: { [create]: createFn, listWebhookEndpoints: vi.fn().mockResolvedValue([]) },
  } as unknown as ServerDeps);
  app.onError((err, c) => {
    const { status, body } = toErrorBody(err);
    return c.json(body, status as Parameters<typeof c.json>[1]);
  });
  return { request: app.request.bind(app), createFn };
}

const post = (
  request: ReturnType<typeof makeApp>["request"],
  path: string,
  body: Record<string, unknown>
) =>
  request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("create routes refuse a sensitivity above the caller's read ceiling", () => {
  for (const k of CASES) {
    it(`POST ${k.path}: restricted write by an internal-ceiling key -> 404 sensitivity_above_ceiling, no row`, async () => {
      const { request, createFn } = makeApp(k.mount, k.create, "internal");
      const res = await post(request, k.path, { ...k.body, sensitivity: "restricted" });
      expect(res.status).toBe(404);
      const json = (await res.json()) as { error?: { code?: string } | string; code?: string };
      expect(JSON.stringify(json)).toContain("sensitivity_above_ceiling");
      expect(createFn).not.toHaveBeenCalled();
    });

    it(`POST ${k.path}: a tier at the ceiling is still written`, async () => {
      const { request, createFn } = makeApp(k.mount, k.create, "internal");
      await post(request, k.path, { ...k.body, sensitivity: "internal" });
      expect(createFn).toHaveBeenCalled();
    });

    it(`POST ${k.path}: no sensitivity (default internal) under a public ceiling is refused`, async () => {
      const { request, createFn } = makeApp(k.mount, k.create, "public");
      const res = await post(request, k.path, k.body);
      expect(res.status).toBe(404);
      expect(createFn).not.toHaveBeenCalled();
    });
  }
});
