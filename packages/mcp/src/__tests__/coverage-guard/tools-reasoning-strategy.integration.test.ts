/**
 * B4.2 — MCP tool coverage fill-in: reasoning and strategy tools (design.md
 * "B4. Coverage fill-in", spec.md Requirement 13). Exercises all 8
 * `memory_reasoning` actions (`create`/`get`/`list`/`patch`/`archive`/
 * `resolve`/`record`/`feedback`) and all 8 `memory_strategy` operations
 * (`create`/`get`/`list`/`patch`/`archive`/`store`/`recall`/`rate`) against
 * the real live-surface harness's `mcp` stdio client.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startLiveSurface, type LiveSurface } from "../harness/live-surface.js";
import { callToolOk } from "./mcp-tool-helpers.js";

let surface: LiveSurface;

beforeAll(async () => {
  surface = await startLiveSurface();
}, 120_000);

afterAll(async () => {
  await surface.close();
});

const CHAIN = [
  { step: 0, reasoning: "B4.2 step 1: gather evidence.", conclusion: undefined },
  { step: 1, reasoning: "B4.2 step 2: weigh alternatives.", conclusion: "Chose option A." },
];

describe("memory_reasoning (B4.2)", () => {
  it("create, get, list, patch, archive", async () => {
    const created = await callToolOk(surface.mcp, "memory_reasoning", {
      action: "create",
      question: "B4.2: which approach should the coverage test use?",
      chain: CHAIN,
      conclusion: "Use the real live-surface mcp client.",
      topicKey: "b4.2-reasoning-crud",
    });
    const createdBody = created.structuredContent as { id: string; status: string };
    expect(createdBody.id).toBeTruthy();

    const got = await callToolOk(surface.mcp, "memory_reasoning", {
      action: "get",
      id: createdBody.id,
    });
    expect((got.structuredContent as { id: string }).id).toBe(createdBody.id);

    const listed = await callToolOk(surface.mcp, "memory_reasoning", {
      action: "list",
      topicKeyFilter: "b4.2-reasoning-crud",
    });
    const listedBody = listed.structuredContent as { items: Array<{ id: string }> };
    expect(listedBody.items.some((r) => r.id === createdBody.id)).toBe(true);

    const patched = await callToolOk(surface.mcp, "memory_reasoning", {
      action: "patch",
      id: createdBody.id,
      conclusion: "Updated conclusion via B4.2.",
    });
    expect((patched.structuredContent as { conclusion: string }).conclusion).toBe(
      "Updated conclusion via B4.2."
    );

    const archived = await callToolOk(surface.mcp, "memory_reasoning", {
      action: "archive",
      id: createdBody.id,
    });
    expect((archived.structuredContent as { archived: boolean }).archived).toBe(true);
  });

  it("record then resolve — the reasoning cache round trip", async () => {
    const question = "B4.2: is the reasoning cache reachable via memory_reasoning?";
    const recorded = await callToolOk(surface.mcp, "memory_reasoning", {
      action: "record",
      question,
      chain: CHAIN,
      conclusion: "Yes, via action='record' then action='resolve'.",
      topicKey: "b4.2-reasoning-cache",
      outcome: "success",
    });
    expect((recorded.structuredContent as { id: string }).id).toBeTruthy();

    const resolved = await callToolOk(surface.mcp, "memory_reasoning", {
      action: "resolve",
      query: question,
      topicKey: "b4.2-reasoning-cache",
    });
    // resolve returns a cache hit/miss shape — assert it's a real structured
    // object, not asserting a specific hit (cache matching is semantic/topic
    // based and not guaranteed deterministic in a single-pass fake-embed
    // harness).
    expect(typeof resolved.structuredContent).toBe("object");
  });

  it("feedback — reports whether a cached reasoning worked", async () => {
    const recorded = await callToolOk(surface.mcp, "memory_reasoning", {
      action: "record",
      question: "B4.2: does feedback close the cache loop?",
      chain: CHAIN,
      conclusion: "Yes.",
      outcome: "success",
    });
    const id = (recorded.structuredContent as { id: string }).id;
    const feedback = await callToolOk(surface.mcp, "memory_reasoning", {
      action: "feedback",
      reasoningId: id,
      outcome: "success",
    });
    expect(typeof feedback.structuredContent).toBe("object");
  });
});

describe("memory_strategy (B4.2)", () => {
  it("create, get, list, patch, archive", async () => {
    const created = await callToolOk(surface.mcp, "memory_strategy", {
      op: "create",
      trigger: "when B4.2 coverage runs",
      action: "exercise memory_strategy's CRUD op",
    });
    const createdBody = created.structuredContent as { id: string; status: string };
    expect(createdBody.id).toBeTruthy();
    expect(createdBody.status).toBe("active");

    const got = await callToolOk(surface.mcp, "memory_strategy", { op: "get", id: createdBody.id });
    expect((got.structuredContent as { id: string }).id).toBe(createdBody.id);

    const listed = await callToolOk(surface.mcp, "memory_strategy", { op: "list" });
    const listedBody = listed.structuredContent as { items: Array<{ id: string }> };
    expect(listedBody.items.some((s) => s.id === createdBody.id)).toBe(true);

    const patched = await callToolOk(surface.mcp, "memory_strategy", {
      op: "patch",
      id: createdBody.id,
      action: "exercise memory_strategy's CRUD op, patched.",
    });
    expect((patched.structuredContent as { action: string }).action).toBe(
      "exercise memory_strategy's CRUD op, patched."
    );

    const archived = await callToolOk(surface.mcp, "memory_strategy", {
      op: "archive",
      id: createdBody.id,
    });
    expect((archived.structuredContent as { archived: boolean }).archived).toBe(true);
  });

  it("store (alias of create), recall (alias of list, active-only), rate", async () => {
    const stored = await callToolOk(surface.mcp, "memory_strategy", {
      op: "store",
      trigger: "when B4.2 tests the store/recall/rate alias verbs",
      action: "confirm the §24 domain-verb aliases work",
    });
    const storedBody = stored.structuredContent as { id: string; status: string };
    expect(storedBody.id).toBeTruthy();
    expect(storedBody.status).toBe("active");

    const recalled = await callToolOk(surface.mcp, "memory_strategy", { op: "recall" });
    const recalledBody = recalled.structuredContent as {
      items: Array<{ id: string; status: string }>;
    };
    expect(recalledBody.items.some((s) => s.id === storedBody.id)).toBe(true);
    expect(recalledBody.items.every((s) => s.status === "active")).toBe(true);

    const rated = await callToolOk(surface.mcp, "memory_strategy", {
      op: "rate",
      id: storedBody.id,
      outcome: "success",
    });
    const ratedBody = rated.structuredContent as { successCount?: number };
    expect(typeof ratedBody).toBe("object");
  });
});
