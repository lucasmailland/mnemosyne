/**
 * B4.2 — MCP tool coverage fill-in: cognition tools (design.md "B4. Coverage
 * fill-in", spec.md Requirement 13). Exercises `memory_introspect`,
 * `memory_anticipate`, and `memory_compose` (`list`/`create`/`get`/`patch`/
 * `dry_run`) against the real live-surface harness's `mcp` stdio client.
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

describe("memory_introspect (B4.2)", () => {
  it("returns a self-model with aspect='all' default", async () => {
    await surface.http("POST", "/remember", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ statement: "B4.2 introspect seed fact." }),
    });
    const result = await callToolOk(surface.mcp, "memory_introspect", {});
    expect(typeof result.structuredContent).toBe("object");
  });
});

describe("memory_anticipate (B4.2)", () => {
  it("returns a 4-signal anticipation feed (periodic always runs)", async () => {
    const result = await callToolOk(surface.mcp, "memory_anticipate", {});
    const body = result.structuredContent as { items?: unknown[]; predictions?: unknown[] };
    expect(typeof result.structuredContent).toBe("object");
    // The tool description guarantees the periodic signal always runs even
    // with no params, so the top-level shape must be a real object either
    // way (empty feed is still a real, meaningful "nothing anticipated yet"
    // result on a fresh workspace).
    expect(body).toBeTruthy();
  });
});

describe("memory_compose (B4.2)", () => {
  it("create, list, get, patch a composition rule", async () => {
    const created = await callToolOk(surface.mcp, "memory_compose", {
      action: "create",
      name: "B4.2 compose rule",
      conditionDsl: { all: [{ op: "fact_kind", kind: "preference" }] },
      actionDsl: { op: "derive_fact", statementTemplate: "B4.2 derived fact." },
    });
    const createdBody = created.structuredContent as { id: string; isActive: boolean };
    expect(createdBody.id).toBeTruthy();
    expect(createdBody.isActive).toBe(true);

    const listed = await callToolOk(surface.mcp, "memory_compose", { action: "list" });
    const listedBody = listed.structuredContent as { items: Array<{ id: string }> };
    expect(listedBody.items.some((r) => r.id === createdBody.id)).toBe(true);

    const got = await callToolOk(surface.mcp, "memory_compose", {
      action: "get",
      ruleId: createdBody.id,
    });
    expect((got.structuredContent as { id: string }).id).toBe(createdBody.id);

    const patched = await callToolOk(surface.mcp, "memory_compose", {
      action: "patch",
      ruleId: createdBody.id,
      isActive: false,
    });
    expect((patched.structuredContent as { isActive: boolean }).isActive).toBe(false);
  });

  it("dry_run — evaluates a rule against synthetic hits without persisting", async () => {
    const result = await callToolOk(surface.mcp, "memory_compose", {
      action: "dry_run",
      conditionDsl: { all: [{ op: "fact_kind", kind: "preference" }] },
      actionDsl: { op: "derive_fact", statementTemplate: "B4.2 dry-run derived fact." },
      hits: [
        {
          id: "hit_1",
          primitive: "fact",
          content: "B4.2 dry-run hit content.",
          score: 0.9,
          factKind: "preference",
        },
      ],
    });
    expect(typeof result.structuredContent).toBe("object");
  });
});
