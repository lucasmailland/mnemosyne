/**
 * S3b — cross-workspace write parity at the MCP tool boundary for
 * memory_strategy, memory_workflow, memory_skill, and memory_remind_when
 * (docs/archive/openspec/p57-cross-workspace-tool-parity). Mirrors the coverage already
 * proven server-side in S2b's
 * packages/server/src/__tests__/target-workspace-routes.test.ts, but at the
 * tool layer: mock the underlying MnemosyneClient, assert the outgoing
 * request body carries `targetWorkspaceId` on the create/store op, and that
 * a non-create op combined with `targetWorkspaceId` is rejected (D5 guard)
 * with zero client calls — never silently dropped.
 *
 * Also proves the response-echo requirement (spec.md "Response Must State
 * the Receiving Workspace"): the tool's `structuredContent` surfaces
 * whatever `workspaceId` the (mocked) server response carries, unmodified.
 */
import { describe, it, expect, vi } from "vitest";
import type { MnemosyneClient } from "@mnemo-ai/client-ts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerStrategy } from "../tools/strategy.js";
import { registerWorkflow } from "../tools/workflow.js";
import { registerSkill } from "../tools/skill.js";
import { registerRemindWhen } from "../tools/remind_when.js";

type Handler = (args: Record<string, unknown>) => Promise<{
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
}>;

function registerAndCapture(
  toolName: string,
  register: (server: McpServer, client: MnemosyneClient) => void,
  client: MnemosyneClient
): Handler {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  let handler: Handler | undefined;
  const orig = server.registerTool.bind(server);
  vi.spyOn(server, "registerTool").mockImplementation(
    (name: string, schema: unknown, cb: Handler) => {
      if (name === toolName) handler = cb;
      return orig(name, schema as Parameters<typeof orig>[1], cb as Parameters<typeof orig>[2]);
    }
  );
  register(server, client);
  if (!handler) throw new Error(`${toolName} was not registered`);
  return handler;
}

const TARGET = "11111111-1111-4111-8111-111111111111";

describe("memory_strategy targetWorkspaceId forwarding (S3b)", () => {
  it("op='create' forwards targetWorkspaceId in the client.createStrategy body", async () => {
    const createStrategy = vi.fn().mockResolvedValue({ id: "strat-1", workspaceId: TARGET });
    const handler = registerAndCapture("memory_strategy", registerStrategy, {
      createStrategy,
    } as unknown as MnemosyneClient);

    const result = await handler({
      op: "create",
      trigger: "Error occurs",
      action: "Retry with backoff",
      targetWorkspaceId: TARGET,
    });

    expect(createStrategy).toHaveBeenCalledTimes(1);
    const [body] = createStrategy.mock.calls[0]!;
    expect(body).toMatchObject({ targetWorkspaceId: TARGET });
    expect(result.structuredContent).toMatchObject({ workspaceId: TARGET });
  });

  it("op='store' (create alias) also forwards targetWorkspaceId", async () => {
    const createStrategy = vi.fn().mockResolvedValue({ id: "strat-1", workspaceId: TARGET });
    const handler = registerAndCapture("memory_strategy", registerStrategy, {
      createStrategy,
    } as unknown as MnemosyneClient);

    await handler({ op: "store", trigger: "t", action: "a", targetWorkspaceId: TARGET });

    const [body] = createStrategy.mock.calls[0]!;
    expect(body).toMatchObject({ targetWorkspaceId: TARGET });
  });

  it("omitting targetWorkspaceId does not add the field to the body", async () => {
    const createStrategy = vi.fn().mockResolvedValue({ id: "strat-1", workspaceId: "own-ws" });
    const handler = registerAndCapture("memory_strategy", registerStrategy, {
      createStrategy,
    } as unknown as MnemosyneClient);

    await handler({ op: "create", trigger: "t", action: "a" });

    const [body] = createStrategy.mock.calls[0]!;
    expect(body).not.toHaveProperty("targetWorkspaceId");
  });

  it("non-create op ('list') + targetWorkspaceId is rejected with isError and zero client calls", async () => {
    const createStrategy = vi.fn();
    const listStrategies = vi.fn();
    const handler = registerAndCapture("memory_strategy", registerStrategy, {
      createStrategy,
      listStrategies,
    } as unknown as MnemosyneClient);

    const result = await handler({ op: "list", targetWorkspaceId: TARGET });

    expect(result.isError).toBe(true);
    expect(createStrategy).not.toHaveBeenCalled();
    expect(listStrategies).not.toHaveBeenCalled();
  });

  it("non-create op ('get') + targetWorkspaceId is rejected with isError and zero client calls", async () => {
    const getStrategy = vi.fn();
    const handler = registerAndCapture("memory_strategy", registerStrategy, {
      getStrategy,
    } as unknown as MnemosyneClient);

    const result = await handler({ op: "get", id: "strat-1", targetWorkspaceId: TARGET });

    expect(result.isError).toBe(true);
    expect(getStrategy).not.toHaveBeenCalled();
  });
});

describe("memory_workflow targetWorkspaceId forwarding (S3b)", () => {
  it("action='create' forwards targetWorkspaceId in the client.createWorkflow body", async () => {
    const createWorkflow = vi.fn().mockResolvedValue({ id: "wf-1", workspaceId: TARGET });
    const handler = registerAndCapture("memory_workflow", registerWorkflow, {
      createWorkflow,
    } as unknown as MnemosyneClient);

    const result = await handler({
      action: "create",
      name: "Deploy",
      steps: [{ order: 0, action: "build", expectedDurationMs: 0 }],
      targetWorkspaceId: TARGET,
    });

    expect(createWorkflow).toHaveBeenCalledTimes(1);
    const [body] = createWorkflow.mock.calls[0]!;
    expect(body).toMatchObject({ targetWorkspaceId: TARGET });
    expect(result.structuredContent).toMatchObject({ workspaceId: TARGET });
  });

  it("omitting targetWorkspaceId does not add the field to the body", async () => {
    const createWorkflow = vi.fn().mockResolvedValue({ id: "wf-1", workspaceId: "own-ws" });
    const handler = registerAndCapture("memory_workflow", registerWorkflow, {
      createWorkflow,
    } as unknown as MnemosyneClient);

    await handler({
      action: "create",
      name: "Deploy",
      steps: [{ order: 0, action: "build", expectedDurationMs: 0 }],
    });

    const [body] = createWorkflow.mock.calls[0]!;
    expect(body).not.toHaveProperty("targetWorkspaceId");
  });

  it("non-create action ('list') + targetWorkspaceId is rejected with isError and zero client calls", async () => {
    const createWorkflow = vi.fn();
    const listWorkflows = vi.fn();
    const handler = registerAndCapture("memory_workflow", registerWorkflow, {
      createWorkflow,
      listWorkflows,
    } as unknown as MnemosyneClient);

    const result = await handler({ action: "list", targetWorkspaceId: TARGET });

    expect(result.isError).toBe(true);
    expect(createWorkflow).not.toHaveBeenCalled();
    expect(listWorkflows).not.toHaveBeenCalled();
  });

  it("non-create action ('get') + targetWorkspaceId is rejected with isError and zero client calls", async () => {
    const getWorkflow = vi.fn();
    const handler = registerAndCapture("memory_workflow", registerWorkflow, {
      getWorkflow,
    } as unknown as MnemosyneClient);

    const result = await handler({ action: "get", id: "wf-1", targetWorkspaceId: TARGET });

    expect(result.isError).toBe(true);
    expect(getWorkflow).not.toHaveBeenCalled();
  });
});

describe("memory_skill targetWorkspaceId forwarding (S3b)", () => {
  it("action='create' forwards targetWorkspaceId in the client.createSkill body", async () => {
    const createSkill = vi.fn().mockResolvedValue({ id: "skill-1", workspaceId: TARGET });
    const handler = registerAndCapture("memory_skill", registerSkill, {
      createSkill,
    } as unknown as MnemosyneClient);

    const result = await handler({
      action: "create",
      name: "Deploy to fly.io",
      promptTemplate: "Run `fly deploy`.",
      targetWorkspaceId: TARGET,
    });

    expect(createSkill).toHaveBeenCalledTimes(1);
    const [body] = createSkill.mock.calls[0]!;
    expect(body).toMatchObject({ targetWorkspaceId: TARGET });
    expect(result.structuredContent).toMatchObject({ workspaceId: TARGET });
  });

  it("omitting targetWorkspaceId does not add the field to the body", async () => {
    const createSkill = vi.fn().mockResolvedValue({ id: "skill-1", workspaceId: "own-ws" });
    const handler = registerAndCapture("memory_skill", registerSkill, {
      createSkill,
    } as unknown as MnemosyneClient);

    await handler({ action: "create", name: "Deploy", promptTemplate: "Run it." });

    const [body] = createSkill.mock.calls[0]!;
    expect(body).not.toHaveProperty("targetWorkspaceId");
  });

  it("non-create action ('list') + targetWorkspaceId is rejected with isError and zero client calls", async () => {
    const createSkill = vi.fn();
    const listSkills = vi.fn();
    const handler = registerAndCapture("memory_skill", registerSkill, {
      createSkill,
      listSkills,
    } as unknown as MnemosyneClient);

    const result = await handler({ action: "list", targetWorkspaceId: TARGET });

    expect(result.isError).toBe(true);
    expect(createSkill).not.toHaveBeenCalled();
    expect(listSkills).not.toHaveBeenCalled();
  });

  it("non-create action ('forget') + targetWorkspaceId is rejected with isError and zero client calls", async () => {
    const forgetPrimitive = vi.fn();
    const handler = registerAndCapture("memory_skill", registerSkill, {
      forgetPrimitive,
    } as unknown as MnemosyneClient);

    const result = await handler({ action: "forget", id: "skill-1", targetWorkspaceId: TARGET });

    expect(result.isError).toBe(true);
    expect(forgetPrimitive).not.toHaveBeenCalled();
  });
});

describe("memory_remind_when targetWorkspaceId forwarding (S3b)", () => {
  it("action='create' forwards targetWorkspaceId in the client.createReminder body", async () => {
    const createReminder = vi.fn().mockResolvedValue({ id: "rem-1", workspaceId: TARGET });
    const handler = registerAndCapture("memory_remind_when", registerRemindWhen, {
      createReminder,
    } as unknown as MnemosyneClient);

    const result = await handler({
      action: "create",
      content: "Follow up with Acme",
      condition: "when Acme is mentioned",
      targetWorkspaceId: TARGET,
    });

    expect(createReminder).toHaveBeenCalledTimes(1);
    const [body] = createReminder.mock.calls[0]!;
    expect(body).toMatchObject({ targetWorkspaceId: TARGET });
    expect(result.structuredContent).toMatchObject({ workspaceId: TARGET });
  });

  it("omitting targetWorkspaceId does not add the field to the body", async () => {
    const createReminder = vi.fn().mockResolvedValue({ id: "rem-1", workspaceId: "own-ws" });
    const handler = registerAndCapture("memory_remind_when", registerRemindWhen, {
      createReminder,
    } as unknown as MnemosyneClient);

    await handler({ action: "create", content: "Follow up", condition: "when mentioned" });

    const [body] = createReminder.mock.calls[0]!;
    expect(body).not.toHaveProperty("targetWorkspaceId");
  });

  it("non-create action ('list') + targetWorkspaceId is rejected with isError and zero client calls", async () => {
    const createReminder = vi.fn();
    const listReminders = vi.fn();
    const handler = registerAndCapture("memory_remind_when", registerRemindWhen, {
      createReminder,
      listReminders,
    } as unknown as MnemosyneClient);

    const result = await handler({ action: "list", targetWorkspaceId: TARGET });

    expect(result.isError).toBe(true);
    expect(createReminder).not.toHaveBeenCalled();
    expect(listReminders).not.toHaveBeenCalled();
  });

  it("non-create action ('dismiss') + targetWorkspaceId is rejected with isError and zero client calls", async () => {
    const createReminder = vi.fn();
    const dismissReminder = vi.fn();
    const handler = registerAndCapture("memory_remind_when", registerRemindWhen, {
      createReminder,
      dismissReminder,
    } as unknown as MnemosyneClient);

    const result = await handler({ action: "dismiss", id: "rem-1", targetWorkspaceId: TARGET });

    expect(result.isError).toBe(true);
    expect(createReminder).not.toHaveBeenCalled();
    expect(dismissReminder).not.toHaveBeenCalled();
  });
});
