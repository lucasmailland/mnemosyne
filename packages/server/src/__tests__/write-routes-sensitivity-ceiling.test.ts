/**
 * A route that takes an id answers 404 for a row above the caller's ceiling,
 * reads and writes alike (final review I1): a write that answers with the row,
 * or a 204 where a missing id gets a 404, would confirm or show what a read
 * hides. The row is left untouched. A caller whose ceiling admits the tier gets
 * the usual answer.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import bcrypt from "bcrypt";
import { BCRYPT_COST } from "../auth.js";
import type { ApiKeyLookup } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";
import { mountFacts } from "../routes/facts.js";
import { mountGovernance } from "../routes/governance.js";
import { mountTasks } from "../routes/tasks.js";
import { mountStrategies } from "../routes/strategies.js";
import { mountReasoning } from "../routes/reasoning.js";
import { mountEvents } from "../routes/events.js";
import { buildMountHarness } from "./_mountHarness.js";

const PLAINTEXT_KEY = "mns_live_writeceiling00000000001";
const WS = "00000000-0000-0000-0000-000000000907";
const MISSING = "00000000-0000-0000-0000-00000000dead";

async function makeApp() {
  const storage = new InMemoryStorageAdapter();
  const fact = await storage.createFact({
    workspaceId: WS,
    scope: "global",
    statement: "A restricted fact",
    subject: "s",
    kind: "trait",
    sensitivity: "restricted",
    sourceMessageIds: ["msg-1"],
  });
  const task = await storage.createTask({
    workspaceId: WS,
    title: "Secret task",
    assignedTo: "a",
    sensitivity: "restricted",
  });
  const strategy = await storage.createStrategy({
    workspaceId: WS,
    trigger: "Secret trigger",
    action: "do",
    sensitivity: "restricted",
  });
  const reasoning = await storage.createReasoning({
    workspaceId: WS,
    question: "Secret question",
    chain: [{ step: 1, reasoning: "step" }],
    conclusion: "Secret conclusion",
  });
  const reasonings = (
    storage as unknown as { state: { reasonings: Map<string, { sensitivity: string }> } }
  ).state.reasonings;
  reasonings.get(reasoning.id)!.sensitivity = "restricted";
  const event = await storage.createEvent({
    workspaceId: WS,
    type: "system",
    name: "Secret launch",
    description: "...",
    occurredAt: new Date("2026-01-01T00:00:00Z"),
    source: "test",
    sensitivity: "restricted",
  });

  // The fake has no relocate; this one must never be reached for a hidden fact.
  Object.assign(storage, { relocateFact: vi.fn(async () => ({ id: "moved" })) });

  const keyHash = await bcrypt.hash(PLAINTEXT_KEY, BCRYPT_COST);
  const apiKeys = {
    listActive: async () => [
      {
        id: "key003",
        keyHash,
        workspaceId: WS,
        scopes: ["memory:read", "memory:write", "memory:admin"],
        plan: "free",
      },
    ],
    touch: async () => {},
  } as unknown as ApiKeyLookup;
  const telemetry = {
    startSpan: () => ({ setAttribute() {}, setStatus() {}, end() {} }),
  };
  const app = buildMountHarness({ apiKeys, storage, telemetry } as unknown as ServerDeps, [
    mountFacts,
    mountGovernance,
    mountTasks,
    mountStrategies,
    mountReasoning,
    mountEvents,
  ]);
  const send = (method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { authorization: `Bearer ${PLAINTEXT_KEY}`, "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  return { storage, send, fact, task, strategy, reasoning, event };
}

type Ctx = Awaited<ReturnType<typeof makeApp>>;
const CASES: Array<[string, (x: Ctx) => [string, string, unknown?]]> = [
  ["GET /facts/:id/citations", (x) => ["GET", `/facts/${x.fact.id}/citations`]],
  ["DELETE /facts/:id", (x) => ["DELETE", `/facts/${x.fact.id}`]],
  [
    "POST /facts/:id/relocate",
    (x) => [
      "POST",
      `/facts/${x.fact.id}/relocate`,
      { targetWorkspaceId: "00000000-0000-0000-0000-000000000908" },
    ],
  ],
  [
    "POST /governance/gate",
    (x) => ["POST", "/governance/gate", { factId: x.fact.id, gate: "canonical" }],
  ],
  ["PATCH /tasks/:id", (x) => ["PATCH", `/tasks/${x.task.id}`, { title: "renamed" }]],
  ["DELETE /tasks/:id", (x) => ["DELETE", `/tasks/${x.task.id}`]],
  [
    "POST /tasks/:id/delegate",
    (x) => ["POST", `/tasks/${x.task.id}/delegate`, { assignedTo: "b" }],
  ],
  ["PATCH /strategies/:id", (x) => ["PATCH", `/strategies/${x.strategy.id}`, { trigger: "t" }]],
  [
    "POST /strategies/:id/rate",
    (x) => ["POST", `/strategies/${x.strategy.id}/rate`, { outcome: "success" }],
  ],
  ["DELETE /strategies/:id", (x) => ["DELETE", `/strategies/${x.strategy.id}`]],
  ["PATCH /reasoning/:id", (x) => ["PATCH", `/reasoning/${x.reasoning.id}`, { conclusion: "c" }]],
  ["DELETE /reasoning/:id", (x) => ["DELETE", `/reasoning/${x.reasoning.id}`]],
  [
    "POST /reasoning/feedback",
    (x) => ["POST", "/reasoning/feedback", { reasoning_id: x.reasoning.id, outcome: "fail" }],
  ],
  [
    "PATCH /events/:id/sensitivity",
    (x) => ["PATCH", `/events/${x.event.id}/sensitivity`, { sensitivity: "restricted" }],
  ],
  [
    "POST /events/:id/annotations",
    (x) => ["POST", `/events/${x.event.id}/annotations`, { author: "a", content: "c" }],
  ],
];

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("routes by id — a row above the ceiling answers 404 and is left alone", () => {
  it.each(CASES)("%s", async (_name, pick) => {
    const x = await makeApp();
    const rows = () =>
      Promise.all([
        x.storage.getFact(x.fact.id, WS),
        x.storage.getTask(x.task.id, WS),
        x.storage.getStrategy(x.strategy.id, WS),
        x.storage.getReasoning(x.reasoning.id, WS),
        x.storage.getEvent(x.event.id, WS),
      ]).then((r) => JSON.stringify(r));
    const before = await rows();
    const [method, path, body] = pick(x);
    const res = await x.send(method, path, body);
    expect(res.status).toBe(404);
    const text = await res.text();
    for (const secret of ["Secret", "msg-1"]) expect(text).not.toContain(secret);
    expect(await rows()).toBe(before);

    // Word for word the 404 a missing id gets.
    const ids = [x.fact.id, x.task.id, x.strategy.id, x.reasoning.id, x.event.id];
    const id = ids.find((i) => path.includes(i) || JSON.stringify(body ?? {}).includes(i))!;
    const swap = (v: string) => v.split(id).join(MISSING);
    const missing = await x.send(
      method,
      swap(path),
      body && JSON.parse(swap(JSON.stringify(body)))
    );
    expect(missing.status).toBe(404);
    expect(swap(text)).toBe(await missing.text());
  });
});

describe("routes by id — ceiling restricted", () => {
  it("GET /facts/:id/citations answers 200 with the source messages", async () => {
    vi.stubEnv("MNEMO_SENSITIVITY_CEILING", "restricted");
    const x = await makeApp();
    const res = await x.send("GET", `/facts/${x.fact.id}/citations`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ factId: x.fact.id, sourceMessageIds: ["msg-1"] });
  });

  it("PATCH /tasks/:id renames the task", async () => {
    vi.stubEnv("MNEMO_SENSITIVITY_CEILING", "restricted");
    const x = await makeApp();
    const res = await x.send("PATCH", `/tasks/${x.task.id}`, { title: "renamed" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { title: string }).title).toBe("renamed");
  });
});
