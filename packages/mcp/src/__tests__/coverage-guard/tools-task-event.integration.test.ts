/**
 * B4.2 — MCP tool coverage fill-in: task and event tools (design.md "B4.
 * Coverage fill-in", spec.md Requirement 13). Exercises all 7 `memory_task`
 * actions (`create`/`get`/`list`/`patch`/`archive`/`delegate`/`complete`)
 * and all 6 `memory_event` actions (`create`/`get`/`list`/`archive`/
 * `annotate`/`sensitivity`) against the real live-surface harness's `mcp`
 * stdio client.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startLiveSurface, type LiveSurface } from "../harness/live-surface.js";
import { callTool, callToolOk } from "./mcp-tool-helpers.js";

let surface: LiveSurface;

beforeAll(async () => {
  surface = await startLiveSurface();
}, 120_000);

afterAll(async () => {
  await surface.close();
});

describe("memory_task (B4.2)", () => {
  it("create, get, list, patch", async () => {
    const created = await callToolOk(surface.mcp, "memory_task", {
      action: "create",
      title: "B4.2 task",
      assignedTo: "agent-b4.2",
    });
    const createdBody = created.structuredContent as { id: string; status: string };
    expect(createdBody.id).toBeTruthy();
    expect(createdBody.status).toBe("pending");

    const got = await callToolOk(surface.mcp, "memory_task", {
      action: "get",
      id: createdBody.id,
    });
    expect((got.structuredContent as { id: string }).id).toBe(createdBody.id);

    const listed = await callToolOk(surface.mcp, "memory_task", { action: "list" });
    const listedBody = listed.structuredContent as { items: Array<{ id: string }> };
    expect(listedBody.items.some((t) => t.id === createdBody.id)).toBe(true);

    const patched = await callToolOk(surface.mcp, "memory_task", {
      action: "patch",
      id: createdBody.id,
      description: "Patched by B4.2.",
    });
    expect((patched.structuredContent as { description: string }).description).toBe(
      "Patched by B4.2."
    );
  });

  it("delegate — moves pending -> in_progress -> delegated (state machine)", async () => {
    const created = await callToolOk(surface.mcp, "memory_task", {
      action: "create",
      title: "B4.2 task to delegate",
      assignedTo: "agent-b4.2",
    });
    const id = (created.structuredContent as { id: string }).id;

    await callToolOk(surface.mcp, "memory_task", {
      action: "patch",
      id,
      status: "in_progress",
    });

    const delegated = await callToolOk(surface.mcp, "memory_task", {
      action: "delegate",
      id,
      assignedTo: "agent-b4.2-delegate",
    });
    const body = delegated.structuredContent as { status: string; assignedTo: string };
    expect(body.status).toBe("delegated");
    expect(body.assignedTo).toBe("agent-b4.2-delegate");
  });

  it("complete — moves pending -> in_progress -> completed with outcome/lessonsLearned", async () => {
    const created = await callToolOk(surface.mcp, "memory_task", {
      action: "create",
      title: "B4.2 task to complete",
      assignedTo: "agent-b4.2",
    });
    const id = (created.structuredContent as { id: string }).id;

    await callToolOk(surface.mcp, "memory_task", {
      action: "patch",
      id,
      status: "in_progress",
    });

    const completed = await callToolOk(surface.mcp, "memory_task", {
      action: "complete",
      id,
      outcome: "Done via B4.2 coverage.",
      lessonsLearned: "The state machine requires in_progress before completed.",
    });
    const body = completed.structuredContent as { status: string; outcome: string };
    expect(body.status).toBe("completed");
    expect(body.outcome).toBe("Done via B4.2 coverage.");
  });

  it("archive", async () => {
    const created = await callToolOk(surface.mcp, "memory_task", {
      action: "create",
      title: "B4.2 task to archive",
      assignedTo: "agent-b4.2",
    });
    const id = (created.structuredContent as { id: string }).id;
    const archived = await callToolOk(surface.mcp, "memory_task", { action: "archive", id });
    expect((archived.structuredContent as { archived: boolean }).archived).toBe(true);
  });
});

describe("memory_event (B4.2)", () => {
  it("create, get, list, annotate, sensitivity", async () => {
    const created = await callToolOk(surface.mcp, "memory_event", {
      action: "create",
      type: "system",
      name: "B4.2 event",
      description: "Event created for B4.2 MCP coverage.",
      occurredAt: new Date().toISOString(), // determinism-ok: throwaway fixture value, not asserted
      source: "b4.2-coverage",
      // Starts below the key's `internal` ceiling so a raise is possible.
      sensitivity: "public",
    });
    const createdBody = created.structuredContent as { id: string; sensitivity: string };
    expect(createdBody.id).toBeTruthy();

    const got = await callToolOk(surface.mcp, "memory_event", {
      action: "get",
      id: createdBody.id,
    });
    expect((got.structuredContent as { id: string }).id).toBe(createdBody.id);

    const listed = await callToolOk(surface.mcp, "memory_event", {
      action: "list",
      sourceFilter: "b4.2-coverage",
    });
    const listedBody = listed.structuredContent as { items: Array<{ id: string }> };
    expect(listedBody.items.some((e) => e.id === createdBody.id)).toBe(true);

    const annotated = await callToolOk(surface.mcp, "memory_event", {
      action: "annotate",
      id: createdBody.id,
      author: "b4.2-agent",
      content: "B4.2 annotation.",
    });
    const annotatedBody = annotated.structuredContent as {
      annotations: Array<{ content: string }>;
    };
    expect(annotatedBody.annotations.some((a) => a.content === "B4.2 annotation.")).toBe(true);

    const raised = await callToolOk(surface.mcp, "memory_event", {
      action: "sensitivity",
      id: createdBody.id,
      sensitivity: "internal",
    });
    expect((raised.structuredContent as { sensitivity: string }).sensitivity).toBe("internal");

    // PRIM-14: `confidential` is above this key's `internal` ceiling; the tool
    // reports the server's refusal and the event keeps its tier.
    const above = await callTool(surface.mcp, "memory_event", {
      action: "sensitivity",
      id: createdBody.id,
      sensitivity: "confidential",
    });
    expect(above.isError).toBe(true);
    expect(JSON.stringify(above.content)).toContain("read ceiling");
    const after = await callToolOk(surface.mcp, "memory_event", {
      action: "get",
      id: createdBody.id,
    });
    expect((after.structuredContent as { sensitivity: string }).sensitivity).toBe("internal");
  });

  it("archive — documented NO-OP: mnemo_event has no status column", async () => {
    const created = await callToolOk(surface.mcp, "memory_event", {
      action: "create",
      type: "system",
      name: "B4.2 event to archive",
      description: "Archiving this event is a declared no-op.",
      occurredAt: new Date().toISOString(), // determinism-ok: throwaway fixture value, not asserted
      source: "b4.2-coverage",
    });
    const id = (created.structuredContent as { id: string }).id;
    const archived = await callToolOk(surface.mcp, "memory_event", { action: "archive", id });
    const body = archived.structuredContent as { archived: boolean; immutable: boolean };
    expect(body.archived).toBe(false);
    expect(body.immutable).toBe(true);
  });
});
