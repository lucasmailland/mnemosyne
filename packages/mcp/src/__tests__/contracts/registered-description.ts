import { vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MnemosyneClient } from "@mnemo-ai/client-ts";
import type { Locale } from "@mnemo-ai/types";
import { registerAllTools } from "../../registry.js";

/**
 * The description a client actually receives for `tool`: the registry sets it
 * from the i18n dictionary (a registrar's own config carries none).
 */
export function registeredDescription(tool: string, locale?: Locale): string {
  const server = new McpServer({ name: "registered-description", version: "0.0.0" });
  let out = "";
  const orig = server.registerTool.bind(server);
  const spy = vi
    .spyOn(server, "registerTool")
    .mockImplementation((name: string, config: unknown, cb: unknown) => {
      if (name === tool) out = (config as { description?: string }).description ?? "";
      return orig(name, config as Parameters<typeof orig>[1], cb as Parameters<typeof orig>[2]);
    });
  registerAllTools(server, {} as MnemosyneClient, locale);
  spy.mockRestore();
  return out;
}
