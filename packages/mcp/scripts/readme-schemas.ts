/**
 * Fills the `<!-- input-schema:memory_x -->` regions of README.md and
 * README.es.md from what the server serves: the JSON schema (types and
 * limits) from `contracts/*.json`, identical in both files, and a field table
 * with the descriptions the MCP serves in that file's language.
 *
 *   pnpm --filter @mnemo-ai/mcp readme:schemas   # rewrite both READMEs
 *
 * `src/__tests__/readme-schemas.test.ts` fails when a README drifts from it.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MnemosyneClient } from "@mnemo-ai/client-ts";
import type { Locale } from "@mnemo-ai/types";
import * as prettier from "prettier";
import { registerAllTools } from "../src/registry.js";

export const READMES: Record<Locale, string> = {
  "en-US": fileURLToPath(new URL("../README.md", import.meta.url)),
  "es-419": fileURLToPath(new URL("../README.es.md", import.meta.url)),
};
const HEADER: Record<Locale, string> = {
  "en-US": "| Field | Description |",
  "es-419": "| Campo | Descripción |",
};
const REGION = /<!-- input-schema:(memory_[a-z_]+) -->\n[\s\S]*?<!-- \/input-schema -->/g;

/** tool → field → the description the MCP serves in `locale`. */
function servedFieldDescriptions(locale: Locale): Map<string, Map<string, string>> {
  const server = new McpServer({ name: "readme-schemas", version: "0.0.0" });
  const out = new Map<string, Map<string, string>>();
  const orig = server.registerTool.bind(server) as (...args: unknown[]) => unknown;
  (server as unknown as { registerTool: unknown }).registerTool = (
    name: string,
    config: { inputSchema?: Record<string, { description?: string }> },
    cb: unknown
  ) => {
    const fields = Object.entries(config.inputSchema ?? {}).flatMap(([field, schema]) =>
      schema.description ? [[field, schema.description] as const] : []
    );
    out.set(name, new Map(fields));
    return orig(name, config, cb);
  };
  registerAllTools(server, {} as MnemosyneClient, locale);
  return out;
}

function withoutDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutDescriptions);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "description" && key !== "$schema")
      .map(([key, v]) => [key, withoutDescriptions(v)])
  );
}

function region(tool: string, locale: Locale, fields: Map<string, string>): string {
  const contractPath = new URL(
    `../contracts/${tool.slice("memory_".length)}.json`,
    import.meta.url
  );
  const schema = JSON.parse(readFileSync(contractPath, "utf8")).inputSchema as {
    properties?: Record<string, unknown>;
  };
  const rows = Object.keys(schema.properties ?? {}).map(
    (field) => `| \`${field}\` | ${(fields.get(field) ?? "—").replace(/\|/g, "\\|")} |`
  );
  return [
    `<!-- input-schema:${tool} -->`,
    "```json",
    JSON.stringify(withoutDescriptions(schema), null, 2),
    "```",
    "",
    HEADER[locale],
    "| --- | --- |",
    ...rows,
    "",
    "<!-- /input-schema -->",
  ].join("\n");
}

/** The README for `locale` with every input-schema region regenerated. */
export async function renderReadme(locale: Locale): Promise<string> {
  const path = READMES[locale];
  const fields = servedFieldDescriptions(locale);
  const text = readFileSync(path, "utf8").replace(REGION, (_, tool: string) => {
    if (!fields.has(tool)) throw new Error(`${path}: ${tool} is not a registered tool`);
    return region(tool, locale, fields.get(tool)!);
  });
  const options = (await prettier.resolveConfig(path)) ?? {};
  return prettier.format(text, { ...options, filepath: path });
}

if (process.argv.includes("--write")) {
  for (const locale of Object.keys(READMES) as Locale[])
    writeFileSync(READMES[locale], await renderReadme(locale));
}
