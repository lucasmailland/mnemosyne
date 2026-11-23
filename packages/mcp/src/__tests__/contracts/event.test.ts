/**
 * Contract test for `memory_event` (packages/mcp/src/tools/event.ts).
 *
 * EVENT-1: `action:"archive"` is a total no-op — `EventRepository.archiveEvent()`
 * (packages/adapter-postgres/src/repositories/EventRepository.ts) takes an
 * unused `_id` and never reads or writes a row; `mnemo_event` has no
 * status/valid_to column at all. The handler already discloses this via
 * `{id, archived:false, immutable:true}` (see output-primitives.ts:481-488
 * for that proof) — this file only asserts the tool's top-level `description`
 * and `action` field also tell the truth.
 */
import { describe, it, expect, vi } from "vitest";
import { MnemosyneAPIError, type MnemosyneClient } from "@mnemo-ai/client-ts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerEvent } from "../../tools/event.js";
import { en } from "../../i18n/en.js";
import { registeredDescription } from "./registered-description.js";

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
};

function registerAndCapture(client: MnemosyneClient): {
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
  description: string;
  fieldDescriptions: Record<string, string>;
} {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  let handler: ((args: Record<string, unknown>) => Promise<ToolResult>) | undefined;
  let description = "";
  let fieldDescriptions: Record<string, string> = {};
  const orig = server.registerTool.bind(server);
  vi.spyOn(server, "registerTool").mockImplementation(
    (
      toolName: string,
      schema: unknown,
      cb: (args: Record<string, unknown>) => Promise<unknown>
    ) => {
      if (toolName === "memory_event") {
        handler = cb as unknown as (args: Record<string, unknown>) => Promise<ToolResult>;
        description = (schema as { description?: string }).description ?? "";
        const shape = (schema as { inputSchema?: Record<string, { description?: string }> })
          .inputSchema;
        fieldDescriptions = Object.fromEntries(
          Object.entries(shape ?? {}).map(([k, v]) => [k, v?.description ?? ""])
        );
      }
      return orig(toolName, schema as Parameters<typeof orig>[1], cb as Parameters<typeof orig>[2]);
    }
  );
  registerEvent(server, client);
  if (!handler) throw new Error("memory_event was not registered");
  return { handler, description: registeredDescription("memory_event"), fieldDescriptions };
}

describe("memory_event — description discloses that archive is a no-op", () => {
  it("does NOT promise archive works, and names the no-op explicitly", () => {
    const { description } = registerAndCapture({} as MnemosyneClient);
    expect(description).toMatch(/archive is a no-op/i);
    expect(description).toContain("{archived:false, immutable:true}");
    expect(registeredDescription("memory_event", "es-419")).toContain("archive no hace nada");
    expect(registeredDescription("memory_event", "es-419")).toContain(
      "{archived:false, immutable:true}"
    );
  });
  it("does not reference the nonexistent tool `memory_fact`", () => {
    const { description } = registerAndCapture({} as MnemosyneClient);
    expect(description).not.toContain("memory_fact");
  });
  it("names `annotate` and `sensitivity` as the two actions that mutate an existing event", () => {
    const { description } = registerAndCapture({} as MnemosyneClient);
    expect(en.fields.memory_event.content).toContain("annotate");
    expect(en.fields.memory_event.sensitivity).toContain("the new tier");
  });
});

describe("memory_event action:'archive' — handler already tells the truth", () => {
  it("returns {archived:false, immutable:true} even though the client call 'succeeds'", async () => {
    const archiveEvent = vi.fn(async () => undefined);
    const { handler } = registerAndCapture({ archiveEvent } as unknown as MnemosyneClient);
    const out = await handler({ action: "archive", id: "evt_1" });
    expect(archiveEvent).toHaveBeenCalledWith("evt_1");
    expect(out.structuredContent).toEqual({ id: "evt_1", archived: false, immutable: true });
  });
});

describe("memory_event action:'archive' — the server now refuses with 409 (WP-5, PRIM-10)", () => {
  it("maps 409 event_immutable onto the same {archived:false, immutable:true} answer", async () => {
    const archiveEvent = vi.fn(async () => {
      throw new MnemosyneAPIError({
        status: 409,
        code: "event_immutable",
        message: "Events are immutable and cannot be deleted",
      });
    });
    const { handler } = registerAndCapture({ archiveEvent } as unknown as MnemosyneClient);
    const out = await handler({ action: "archive", id: "evt_1" });
    expect(out.isError).toBeUndefined();
    expect(out.structuredContent).toEqual({ id: "evt_1", archived: false, immutable: true });
  });

  it("still reports any other failure (a 404 above the caller's ceiling) as an error", async () => {
    const archiveEvent = vi.fn(async () => {
      throw new MnemosyneAPIError({ status: 404, code: "not_found", message: "not found" });
    });
    const { handler } = registerAndCapture({ archiveEvent } as unknown as MnemosyneClient);
    const out = await handler({ action: "archive", id: "evt_1" });
    expect(out.isError).toBe(true);
  });
});

describe("memory_event action:'sensitivity' — orphan-route fix (PATCH /events/:id/sensitivity)", () => {
  it("calls client.updateEventSensitivity with id and the new tier", async () => {
    const updateEventSensitivity = vi.fn(async () => ({
      id: "evt_1",
      sensitivity: "confidential",
    }));
    const { handler } = registerAndCapture({
      updateEventSensitivity,
    } as unknown as MnemosyneClient);
    const out = await handler({ action: "sensitivity", id: "evt_1", sensitivity: "confidential" });
    expect(updateEventSensitivity).toHaveBeenCalledWith("evt_1", { sensitivity: "confidential" });
    expect(out.structuredContent).toEqual({ id: "evt_1", sensitivity: "confidential" });
  });

  it("rejects when `id` is missing", async () => {
    const { handler } = registerAndCapture({} as MnemosyneClient);
    const out = await handler({ action: "sensitivity", sensitivity: "confidential" });
    expect(out.isError).toBe(true);
  });

  it("rejects when `sensitivity` is missing", async () => {
    const { handler } = registerAndCapture({} as MnemosyneClient);
    const out = await handler({ action: "sensitivity", id: "evt_1" });
    expect(out.isError).toBe(true);
  });
});

/**
 * The declared contract and the enforced contract must agree.
 *
 * `inputSchema` marks `type`, `name`, `description`, `occurredAt` and `source`
 * all `.optional()` — `action` is the only field flagged `required` — while the
 * handler rejects `create` unless all five are present:
 *
 *   event.ts:74  if (!args.type || !args.name || !args.description ||
 *                    !args.occurredAt || !args.source)
 *
 * An MCP client sees nothing but `inputSchema`. Building the call the schema
 * describes therefore produced a runtime rejection, and the tool gave no way to
 * know that in advance. `memory_task` already solves this for the same
 * multi-action shape by saying so per field ("Required for create."); this
 * pins `memory_event` to the same convention, and pins it to the fields the
 * handler ACTUALLY checks rather than to a hand-copied list that can drift.
 */
describe("memory_event — the schema declares what create actually requires", () => {
  const REQUIRED_FOR_CREATE = ["type", "name", "description", "occurredAt", "source"] as const;

  it.each(REQUIRED_FOR_CREATE)("marks `%s` as required for create", (field) => {
    const { fieldDescriptions } = registerAndCapture({} as MnemosyneClient);
    expect(fieldDescriptions[field] ?? "").toMatch(/required for create/i);
  });

  it("rejects a create that omits them, naming every one", async () => {
    const { handler } = registerAndCapture({} as MnemosyneClient);

    const res = await handler({ action: "create" });

    expect(res.isError).toBe(true);
    const text = res.content[0]?.text ?? "";
    for (const field of REQUIRED_FOR_CREATE) expect(text).toContain(field);
  });

  it("does not over-declare: `durationS` is genuinely optional on create", () => {
    const { fieldDescriptions } = registerAndCapture({} as MnemosyneClient);
    expect(fieldDescriptions.durationS ?? "").not.toMatch(/required for create/i);
  });
});
