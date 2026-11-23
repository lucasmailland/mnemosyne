/**
 * POST /import needs only memory:write, so a capped key reaches it. A line
 * whose id names a row above the caller's ceiling must not overwrite (or be
 * reported against) that row: for this caller the row does not exist, so the
 * line is imported as a new row, exactly as for an id that names nothing. A
 * caller whose ceiling admits the row overwrites it as before.
 */
import { afterEach, describe, it, expect, vi } from "vitest";
import bcrypt from "bcrypt";
import { BCRYPT_COST } from "../auth.js";
import type { ApiKeyLookup } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";
import { mountImport } from "../routes/import-route.js";
import { JSONL_FORMAT_VERSION } from "../routes/export.js";
import { buildMountHarness } from "./_mountHarness.js";

const KEY = "mns_live_importceiling0000000001";
const WS = "00000000-0000-0000-0000-0000000000f6";

async function makeApp() {
  const storage = new InMemoryStorageAdapter();
  const keyHash = await bcrypt.hash(KEY, BCRYPT_COST);
  const apiKeys = {
    listActive: async () => [{ id: "k", keyHash, workspaceId: WS, scopes: ["memory:write"] }],
    touch: async () => {},
  } as unknown as ApiKeyLookup;
  const app = buildMountHarness({ apiKeys, storage } as unknown as ServerDeps, [mountImport]);
  const fact = await storage.createFact({
    workspaceId: WS,
    scope: "global",
    statement: "A restricted fact",
    subject: "s",
    kind: "trait",
    sensitivity: "restricted",
  });
  const task = await storage.createTask({
    workspaceId: WS,
    title: "Secret task",
    assignedTo: "a",
    sensitivity: "restricted",
  });
  const reasoning = await storage.createReasoning({
    workspaceId: WS,
    question: "Secret question",
    chain: [{ step: 1, reasoning: "step" }],
    conclusion: "Secret conclusion",
  });
  (
    storage as unknown as { state: { reasonings: Map<string, { sensitivity: string }> } }
  ).state.reasonings.get(reasoning.id)!.sensitivity = "restricted";
  const event = await storage.createEvent({
    workspaceId: WS,
    type: "system",
    name: "Secret launch",
    description: "...",
    occurredAt: new Date("2026-01-01T00:00:00Z"),
    source: "test",
    sensitivity: "restricted",
  });
  const lines = [
    { _type: "fact", id: fact.id, statement: "overwritten", subject: "s", kind: "trait" },
    { _type: "task", id: task.id, title: "overwritten" },
    { _type: "reasoning", id: reasoning.id, question: "q", conclusion: "overwritten" },
    {
      _type: "event",
      id: event.id,
      type: "system",
      name: "Imported",
      description: "d",
      source: "import",
    },
  ];
  const body =
    [{ _type: "header", version: JSONL_FORMAT_VERSION, workspaceId: WS }, ...lines]
      .map((l) => JSON.stringify(l))
      .join("\n") + "\n";
  const run = async () => {
    const res = await app.request("/import?conflictResolution=overwrite", {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/x-ndjson" },
      body,
    });
    expect(res.status).toBe(200);
    return (await res.json()) as {
      imported: Record<string, number>;
      skippedByReason: Record<string, Record<string, number>>;
    };
  };
  const hiddenRows = async () =>
    JSON.stringify([
      (await storage.getFact(fact.id, WS))!.statement,
      (await storage.getTask(task.id, WS))!.title,
      (await storage.getReasoning(reasoning.id, WS))!.conclusion,
    ]);
  return { run, hiddenRows, app };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /import — ids above the caller's ceiling", () => {
  it("never overwrites them; each line imports as a new row, as for an unknown id", async () => {
    const { run, hiddenRows } = await makeApp();
    const before = await hiddenRows();
    const summary = await run();
    expect(await hiddenRows()).toBe(before);
    expect(summary.imported).toEqual({ fact: 1, task: 1, reasoning: 1, event: 1 });
    expect(summary.skippedByReason).toEqual({});
  });

  it("a line above the caller's own ceiling is skipped as above-ceiling, whatever the workspace holds", async () => {
    const { app } = await makeApp();
    const body =
      [
        { _type: "header", version: JSONL_FORMAT_VERSION, workspaceId: WS },
        { _type: "fact", id: "new-1", statement: "s", subject: "s", sensitivity: "restricted" },
        { _type: "task", id: "new-2", title: "t", sensitivity: "confidential" },
      ]
        .map((l) => JSON.stringify(l))
        .join("\n") + "\n";
    const res = await app.request("/import", {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/x-ndjson" },
      body,
    });
    const summary = (await res.json()) as {
      imported: Record<string, number>;
      skippedByReason: Record<string, Record<string, number>>;
    };
    expect(summary.imported).toEqual({});
    expect(summary.skippedByReason).toEqual({
      fact: { "above-ceiling": 1 },
      task: { "above-ceiling": 1 },
    });
  });

  it("a caller whose ceiling admits them overwrites as before", async () => {
    vi.stubEnv("MNEMO_SENSITIVITY_CEILING", "restricted");
    const { run, hiddenRows } = await makeApp();
    const summary = await run();
    expect(JSON.parse(await hiddenRows())).toEqual(["overwritten", "overwritten", "overwritten"]);
    expect(summary.skippedByReason["event"]?.["immutable-exists"]).toBe(1);
  });
});
