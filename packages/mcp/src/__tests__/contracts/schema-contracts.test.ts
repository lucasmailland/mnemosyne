import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { CORE_TOOL_NAMES, MCP_TOOL_COUNT } from "../../registry.js";
import { EXPECTED_TOOL_NAMES } from "../tool-names.js";
import { normalizeSchema, type JsonValue } from "./schema-normalizer.js";
import { listBuiltTools } from "./stdio-tools.js";

const CONTRACTS_DIR = new URL("../../../contracts/", import.meta.url);

interface ToolContractArtifact {
  formatVersion: 1;
  tool: string;
  inputSchema: JsonValue;
}

describe("built MCP input schemas", () => {
  it("lists every ordered tool without making HTTP requests when MNEMO_MCP_TOOLS is unset", async () => {
    const fixture = await listBuiltTools();
    try {
      expect(fixture.tools).toHaveLength(MCP_TOOL_COUNT);
      expect(fixture.tools.map(({ name }) => name)).toEqual(EXPECTED_TOOL_NAMES);
      expect(fixture.httpRequestCount()).toBe(0);
      for (const tool of fixture.tools) {
        expect(tool.inputSchema).toMatchObject({ type: "object" });
      }
    } finally {
      await fixture.close();
    }
  });

  it("serves the full profile when MNEMO_MCP_TOOLS is blank", async () => {
    const fixture = await listBuiltTools("");
    try {
      expect(fixture.tools.map(({ name }) => name)).toEqual(EXPECTED_TOOL_NAMES);
    } finally {
      await fixture.close();
    }
  });

  it("serves the core profile when MNEMO_MCP_TOOLS=core", async () => {
    const fixture = await listBuiltTools("core");
    try {
      expect(fixture.tools.map(({ name }) => name)).toEqual(
        EXPECTED_TOOL_NAMES.filter((name) => CORE_TOOL_NAMES.includes(name)),
      );
      expect(fixture.tools).toHaveLength(9);
      // The built server compacts what it advertises (tool-surface.ts), not just the unit tests.
      expect(JSON.stringify(fixture.tools)).not.toContain('"$schema"');
    } finally {
      await fixture.close();
    }
  });

  it("keeps recall requestId optional", async () => {
    const fixture = await listBuiltTools();
    try {
      const recall = fixture.tools.find(({ name }) => name === "memory_recall");
      const schema = recall?.inputSchema as
        { properties?: Record<string, unknown>; required?: string[] } | undefined;
      expect(schema?.properties).toHaveProperty("requestId");
      expect(schema?.required ?? []).not.toContain("requestId");
    } finally {
      await fixture.close();
    }
  });

  it("matches all committed artifacts bidirectionally and exactly", async () => {
    const fixture = await listBuiltTools();
    try {
      const contractFiles = (await readdir(CONTRACTS_DIR))
        .filter((file) => file.endsWith(".json"))
        .sort();
      const artifacts = await Promise.all(
        contractFiles.map(async (file) => {
          const raw = await readFile(new URL(file, CONTRACTS_DIR), "utf8");
          return {
            file,
            raw,
            artifact: JSON.parse(raw) as ToolContractArtifact,
          };
        })
      );
      const wireNames = fixture.tools.map(({ name }) => name);
      const sortedWireNames = [...wireNames].sort();
      const artifactNames = artifacts.map(({ artifact }) => artifact.tool).sort();
      const fileSuffixes = contractFiles.map((file) => file.slice(0, -".json".length));
      const expectedSuffixes = sortedWireNames.map((name) => name.slice("memory_".length));

      expect(wireNames).toEqual(EXPECTED_TOOL_NAMES);
      expect(contractFiles).toHaveLength(MCP_TOOL_COUNT);
      expect(artifactNames).toEqual(sortedWireNames);
      expect(fileSuffixes).toEqual(expectedSuffixes);
      expect(fixture.httpRequestCount()).toBe(0);

      const wireTools = new Map(fixture.tools.map((tool) => [tool.name, tool]));
      for (const { artifact, raw } of artifacts) {
        const wireTool = wireTools.get(artifact.tool);
        expect(wireTool, `missing wire tool ${artifact.tool}`).toBeDefined();
        const expectedArtifact: ToolContractArtifact = {
          formatVersion: 1,
          tool: artifact.tool,
          inputSchema: normalizeSchema(wireTool?.inputSchema),
        };
        expect(artifact).toEqual(expectedArtifact);
        expect(raw).toBe(`${JSON.stringify(expectedArtifact, null, 2)}\n`);
      }
    } finally {
      await fixture.close();
    }
  });

  it("checks remember, decide, and episode_end descriptions against generated input fields", async () => {
    const fixture = await listBuiltTools();
    try {
      const wireTools = new Map(fixture.tools.map((tool) => [tool.name, tool]));

      const remember = wireTools.get("memory_remember");
      expect(remember, "missing memory_remember tool").toBeDefined();
      const rememberProps = (
        remember?.inputSchema as { properties?: Record<string, { description?: string }> }
      )?.properties;
      expect(rememberProps?.subtype?.description).toContain(
        "A choice with rationale is a decision: use memory_decide"
      );
      expect(rememberProps?.sessionId?.description).toContain(
        "The session id returned by memory_episode_start"
      );

      const decide = wireTools.get("memory_decide");
      expect(decide, "missing memory_decide tool").toBeDefined();
      const decideProps = (
        decide?.inputSchema as { properties?: Record<string, { description?: string }> }
      )?.properties;
      expect(decideProps?.sessionId).toBeUndefined();
      expect(decideProps?.conversationId?.description).toContain(
        "pass the episode sessionId here; decide has no sessionId parameter of its own"
      );

      const episodeEnd = wireTools.get("memory_episode_end");
      expect(episodeEnd, "missing memory_episode_end tool").toBeDefined();
      const episodeEndProps = (
        episodeEnd?.inputSchema as { properties?: Record<string, { description?: string }> }
      )?.properties;
      expect(episodeEndProps?.sessionId?.description).toContain(
        "ID of the episode/session to close. Returned by `memory_episode_start`"
      );
      expect(episodeEndProps?.sessionId?.description).toContain("mnemo-managed-v1:");
      expect(episodeEnd?.description).toMatch(/pure MCP/);
      expect(decide?.description).toMatch(/sessionId as conversationId/);
    } finally {
      await fixture.close();
    }
  });
});
