/**
 * Contract test for `memory_workflow` (packages/mcp/src/tools/workflow.ts),
 * covering docs/archive/openspec/tool-promise-remediation/tools/memory_workflow.md.
 *
 * The audit's headline scenario is "step-order round-trip": a workflow whose
 * steps come back reordered is worse than one that fails to save, because the
 * agent executes it anyway. This file proves the MCP layer forwards `steps`
 * as given — no sorting, no renumbering, no dropping.
 *
 * Also pinned: `update` must not be reachable without an `id`. A `PATCH`
 * without a target that silently became a create would fork the workflow into
 * two versions with nothing pointing at the newer one.
 *
 * The `status` enum here is `active | deprecated | draft` — NOT
 * `active | archived`, which is the intuitive guess and the one a previous
 * change nearly shipped. Asserted so the wrong triple cannot creep back in.
 */
import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MnemosyneClient } from "@mnemo-ai/client-ts";

import { registerWorkflow } from "../../tools/workflow.js";
import { registeredDescription } from "./registered-description.js";

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
};

function capture(client: MnemosyneClient): {
  call: (args: Record<string, unknown>) => Promise<ToolResult>;
} {
  const server = new McpServer({ name: "workflow-test", version: "0.0.0" });
  let handler: ((a: Record<string, unknown>) => Promise<ToolResult>) | undefined;
  const orig = server.registerTool.bind(server);
  vi.spyOn(server, "registerTool").mockImplementation(
    (name: string, schema: unknown, cb: (a: Record<string, unknown>) => Promise<unknown>) => {
      if (name === "memory_workflow") {
        handler = cb as typeof handler;
      }
      return orig(name, schema as Parameters<typeof orig>[1], cb as Parameters<typeof orig>[2]);
    }
  );
  registerWorkflow(server, client);
  if (!handler) throw new Error("memory_workflow was not registered");
  return { call: handler };
}

const stub = (p: Record<string, unknown>): MnemosyneClient => p as unknown as MnemosyneClient;

describe("memory_workflow — contract", () => {
  it("forwards steps in the caller's order, unmodified", async () => {
    const createWorkflow = vi.fn<(body: { steps: unknown[] }) => Promise<{ id: string }>>(
      async () => ({ id: "w1" })
    );
    const { call } = capture(stub({ createWorkflow }));
    const steps = [
      { order: 1, action: "validar contrato", expectedDurationMs: 1000 },
      { order: 2, action: "alta en el ERP", expectedDurationMs: 2000 },
      { order: 3, action: "notificar a compras", expectedDurationMs: 500 },
    ];

    await call({ action: "create", name: "Alta de proveedor", steps });

    const sent = createWorkflow.mock.calls[0]![0];
    // Identity, not just length: a reordered workflow still "saves fine" and
    // then runs in the wrong sequence.
    expect(sent.steps).toEqual(steps);
  });

  it("update requires an id and never falls through to create", async () => {
    const updateWorkflow = vi.fn();
    const createWorkflow = vi.fn();
    const { call } = capture(stub({ updateWorkflow, createWorkflow }));

    const res = await call({ action: "update", name: "sin id" });

    expect(res.isError).toBe(true);
    expect(updateWorkflow).not.toHaveBeenCalled();
    expect(createWorkflow).not.toHaveBeenCalled();
  });

  it("get and list reach their own methods", async () => {
    const getWorkflow = vi.fn(async () => ({ id: "w1" }));
    const listWorkflows = vi.fn(async () => []);
    const { call } = capture(stub({ getWorkflow, listWorkflows }));

    await call({ action: "get", id: "w1" });
    expect(getWorkflow).toHaveBeenCalledWith("w1");

    await call({ action: "list" });
    expect(listWorkflows).toHaveBeenCalledTimes(1);
  });

  it("never documents the wrong status triple (active|archived)", () => {
    // The description a client receives comes from the dictionary, not the registrar's config.
    for (const [locale, archived] of [
      ["en-US", /\barchived\b/],
      ["es-419", /\barchivad[oa]s?\b/i],
    ] as const) {
      const description = registeredDescription("memory_workflow", locale);
      expect(description.length).toBeGreaterThan(0);
      expect(description).not.toMatch(archived);
    }
  });
});
