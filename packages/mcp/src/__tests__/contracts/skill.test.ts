/**
 * Contract test for `memory_skill` (packages/mcp/src/tools/skill.ts),
 * covering docs/archive/openspec/tool-promise-remediation/tools/memory_skill.md.
 *
 * This tool carries a documented, already-fixed bug worth pinning forever:
 * `action:"forget"` used to call `client.forgetFact(id)`, which hits
 * `DELETE /facts/:id`. A skill id never exists in `mnemo_fact`, so the call
 * ALWAYS 404d and left the skill row completely untouched — a delete that
 * reported failure and changed nothing, for every skill, always. It now calls
 * `client.forgetPrimitive("skill", id)`.
 *
 * That is exactly the regression a contract test exists to prevent: nothing
 * about the fix is visible from the tool's description, so only an assertion
 * on WHICH client method is called can keep it from sliding back.
 *
 * The DB half — that the archive really reaches `mnemo_skill` and sets
 * `validTo` under the production role — is proven in
 * `server/src/__tests__/integration/skills-forget.integration.test.ts`.
 */
import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MnemosyneClient } from "@mnemo-ai/client-ts";

import { registerSkill } from "../../tools/skill.js";

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
};

function capture(client: MnemosyneClient): {
  call: (args: Record<string, unknown>) => Promise<ToolResult>;
  description: string;
} {
  const server = new McpServer({ name: "skill-test", version: "0.0.0" });
  let handler: ((a: Record<string, unknown>) => Promise<ToolResult>) | undefined;
  let description = "";
  const orig = server.registerTool.bind(server);
  vi.spyOn(server, "registerTool").mockImplementation(
    (name: string, schema: unknown, cb: (a: Record<string, unknown>) => Promise<unknown>) => {
      if (name === "memory_skill") {
        handler = cb as typeof handler;
        description = (schema as { description?: string }).description ?? "";
      }
      return orig(name, schema as Parameters<typeof orig>[1], cb as Parameters<typeof orig>[2]);
    }
  );
  registerSkill(server, client);
  if (!handler) throw new Error("memory_skill was not registered");
  return { call: handler, description };
}

const stub = (p: Record<string, unknown>): MnemosyneClient => p as unknown as MnemosyneClient;

describe("memory_skill — contract", () => {
  it("forget routes through the PRIMITIVE archive path, never forgetFact", async () => {
    const forgetPrimitive = vi.fn(async () => ({ forgotten: true }));
    const forgetFact = vi.fn();
    const { call } = capture(stub({ forgetPrimitive, forgetFact }));

    await call({ action: "forget", id: "skill_1" });

    expect(forgetPrimitive).toHaveBeenCalledWith("skill", "skill_1");
    // The regression guard. `forgetFact` would 404 against mnemo_fact and
    // leave the skill untouched — a delete that changes nothing.
    expect(forgetFact).not.toHaveBeenCalled();
  });

  it("create, get, list and update each reach their own client method", async () => {
    const createSkill = vi.fn(async () => ({ id: "s1" }));
    const getSkill = vi.fn(async () => ({ id: "s1" }));
    const listSkills = vi.fn(async () => []);
    const updateSkill = vi.fn(async () => ({ id: "s1" }));
    const { call } = capture(stub({ createSkill, getSkill, listSkills, updateSkill }));

    await call({ action: "create", name: "Auditar deps", promptTemplate: "revisa el lockfile" });
    await call({ action: "get", id: "s1" });
    await call({ action: "list" });
    await call({ action: "update", id: "s1", name: "Auditar dependencias" });

    expect(createSkill).toHaveBeenCalledTimes(1);
    expect(getSkill).toHaveBeenCalledWith("s1");
    expect(listSkills).toHaveBeenCalledTimes(1);
    expect(updateSkill).toHaveBeenCalledTimes(1);
  });

  it("surfaces a client failure as a tool error", async () => {
    const { call } = capture(
      stub({
        getSkill: vi.fn(async () => {
          throw new Error("404 skill not found");
        }),
      })
    );
    const res = await call({ action: "get", id: "gone" });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("404 skill not found");
  });
});
