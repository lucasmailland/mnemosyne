/**
 * PRIM-16 (V-6) — a forgotten task (status cancelled, validTo set) and a
 * forgotten reasoning chain (status archived, validTo set) stayed in their
 * default lists. They now follow the contract of decisions, strategies and
 * workflows: current rows by default, history with `?includeClosed=true`,
 * the filter applied before LIMIT and `total`, an explicit `status` still
 * answering for that lifecycle state.
 */
import { describe, it, expect } from "vitest";
import bcrypt from "bcrypt";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";

import { BCRYPT_COST } from "../auth.js";
import type { ApiKeyLookup } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import { mountReasoning } from "../routes/reasoning.js";
import { mountTasks } from "../routes/tasks.js";
import { buildMountHarness } from "./_mountHarness.js";

const WS = "00000000-0000-0000-0000-0000000000f6";
const KEY = "mns_live_tasksreasoninglistcurrent01";

async function makeApp() {
  const keyHash = await bcrypt.hash(KEY, BCRYPT_COST);
  const apiKeys = {
    listActive: async () => [
      { id: "k-list", keyHash, workspaceId: WS, scopes: ["memory:read", "memory:write"] },
    ],
    findByLookupHash: undefined,
    setLookupHash: undefined,
    touch: async () => {},
  } as unknown as ApiKeyLookup;
  const storage = new InMemoryStorageAdapter();
  const deps = { apiKeys, storage } as unknown as ServerDeps;
  return { app: buildMountHarness(deps, [mountTasks, mountReasoning]), storage };
}

interface Page {
  items: Array<{ id: string; status: string }>;
  total: number;
  hasMore: boolean;
}
const get = async (app: Awaited<ReturnType<typeof makeApp>>["app"], path: string) => {
  const res = await app.request(path, { headers: { authorization: `Bearer ${KEY}` } });
  expect(res.status).toBe(200);
  return (await res.json()) as Page;
};

describe("GET /tasks — current rows by default", () => {
  it("hides a forgotten task, keeps it under includeClosed and status, and filters before LIMIT and total", async () => {
    const { app, storage } = await makeApp();
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const t = await storage.createTask({
        workspaceId: WS,
        title: `task ${i}`,
        assignedTo: "agent",
      } as never);
      ids.push(t.id);
    }
    for (const id of ids.slice(0, 4)) await storage.archiveTask(id, WS);
    // a completed task is finished work, not a forgotten one: it stays current.
    await storage.updateTask(ids[4]!, { workspaceId: WS, status: "completed" } as never);

    const current = await get(app, "/tasks");
    expect(current.items.map((t) => t.id).sort()).toEqual([ids[4]!, ids[5]!].sort());
    expect(current.total).toBe(2);

    const page = await get(app, "/tasks?limit=2");
    expect(page.items).toHaveLength(2);
    expect(page.total).toBe(2);
    expect(page.hasMore).toBe(false);

    const history = await get(app, "/tasks?includeClosed=true");
    expect(history.total).toBe(6);

    const cancelled = await get(app, "/tasks?status=cancelled");
    expect(cancelled.items.map((t) => t.id).sort()).toEqual(ids.slice(0, 4).sort());
    const completed = await get(app, "/tasks?status=completed");
    expect(completed.items.map((t) => t.id)).toEqual([ids[4]]);
  });
});

describe("GET /reasoning — current rows by default", () => {
  it("hides an archived chain, keeps it under includeClosed and status, and filters before LIMIT and total", async () => {
    const { app, storage } = await makeApp();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await storage.createReasoning({
        workspaceId: WS,
        question: `q${i}`,
        chain: [{ step: 1, reasoning: "x" }],
        conclusion: `c${i}`,
      } as never);
      ids.push(r.id);
    }
    for (const id of ids.slice(0, 3)) await storage.archiveReasoning(id, WS);

    const current = await get(app, "/reasoning");
    expect(current.items.map((r) => r.id).sort()).toEqual(ids.slice(3).sort());
    expect(current.total).toBe(2);

    const page = await get(app, "/reasoning?limit=1");
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(2);
    expect(page.hasMore).toBe(true);

    const history = await get(app, "/reasoning?includeClosed=true");
    expect(history.total).toBe(5);

    const archived = await get(app, "/reasoning?status=archived");
    expect(archived.items.map((r) => r.id).sort()).toEqual(ids.slice(0, 3).sort());
  });
});
