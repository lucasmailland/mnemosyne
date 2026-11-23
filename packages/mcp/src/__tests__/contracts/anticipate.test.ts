/**
 * Contract test for `memory_anticipate` (packages/mcp/src/tools/anticipate.ts).
 *
 * ANTICIPATE-1: the description mentioned only 2 of the real blend's 4
 * weighted sources (packages/core/src/cognitive/anticipation.ts, spec §30):
 * sequential .35 (requires recentlyRecalledId), periodic .25 (ungated,
 * always runs), conditional .25 (requires `context`/`queryContext`, does
 * NOT depend on recentlyRecalledId), co-occurrence/Hebbian .15 (requires
 * recentlyRecalledId). It also claimed "Sin él [recentlyRecalledId], solo
 * periodicidad cuenta" — false, since the conditional branch still runs
 * whenever `context` is supplied, independent of recentlyRecalledId.
 *
 * D7 / spec Requirement 8 (docs/archive/openspec/complete-mcp-tools, 2026-08-10): the
 * description still omitted the 5th, LLM-enrichment signal implemented in
 * `packages/server/src/routes/anticipation.ts::enrichWithLlmContext` (fires
 * only when `context` is supplied AND an LLM adapter is configured — purely
 * additive, non-fatal). Pure documentation fix, no behavior change.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { MnemosyneClient } from "@mnemo-ai/client-ts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAnticipate } from "../../tools/anticipate.js";
import { en } from "../../i18n/en.js";
import { registeredDescription } from "./registered-description.js";

function registerAndCapture(client: MnemosyneClient): { description: string } {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  let description = "";
  const orig = server.registerTool.bind(server);
  vi.spyOn(server, "registerTool").mockImplementation(
    (toolName: string, schema: unknown, cb: unknown) => {
      if (toolName === "memory_anticipate") {
        description = (schema as { description?: string }).description ?? "";
      }
      return orig(toolName, schema as Parameters<typeof orig>[1], cb as Parameters<typeof orig>[2]);
    }
  );
  registerAnticipate(server, client);
  return { description: registeredDescription("memory_anticipate") };
}

describe("memory_anticipate — served description and fields", () => {
  it("is described, in both languages", () => {
    expect(registeredDescription("memory_anticipate")).toContain("anticipatory");
    expect(registeredDescription("memory_anticipate", "es-419")).toContain("anticipatoria");
  });
  it("states each blend weight exactly as core/cognitive/anticipation.ts sets it", () => {
    const core = readFileSync(
      fileURLToPath(new URL("../../../../core/src/cognitive/anticipation.ts", import.meta.url)),
      "utf8"
    );
    const weight = (name: string) =>
      Number(new RegExp(`BLEND_${name}_WEIGHT\\s*=\\s*([0-9.]+)`).exec(core)![1]);
    const description = registeredDescription("memory_anticipate");
    const spanish = registeredDescription("memory_anticipate", "es-419");
    for (const [name, en, es] of [
      ["SEQUENTIAL", "sequential", "secuencial"],
      ["PERIODIC", "periodic", "periódica"],
      ["CONDITIONAL", "conditional", "condicional"],
      ["COOCCURRENCE", "co-occurrence", "coocurrencia"],
    ] as const) {
      expect(description).toContain(`${en} ${weight(name)}`);
      expect(spanish).toContain(`${es} ${weight(name)}`);
    }
    expect(description).toContain("'blended'");
  });
  it("states that the conditional branch is driven by `context`, not by recentlyRecalledId", () => {
    expect(en.fields.memory_anticipate.context).toContain("conditional");
    expect(en.fields.memory_anticipate.recentlyRecalledId).toContain("sequential");
  });
});
