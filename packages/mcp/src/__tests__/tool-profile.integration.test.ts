/**
 * Plan 7.3 (audit 2026-11-22) — the tool profile the BUILT stdio child serves
 * against the real server (non-superuser role). With MNEMO_MCP_TOOLS unset the
 * child lists every tool (owner decision 2026-11-22), and they answer through
 * the real stack; `full` says the same; `core` lists the nine core tools and
 * refuses the rest.
 * tool-profile.test.ts proves the registry in-process; this proves the shipped
 * binary reads the environment the way a host leaves it.
 *
 * Requires Docker + the builds listed in `./harness/live-surface.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { callTool, startLiveSurface, type LiveSurface } from "./harness/live-surface.js";
import { EXPECTED_TOOL_NAMES } from "./tool-names.js";

const CORE = [
  "memory_context",
  "memory_decide",
  "memory_fact",
  "memory_forget",
  "memory_recall",
  "memory_remember",
  "memory_search",
  "memory_status",
  "memory_update",
];

let surface: LiveSurface;

beforeAll(async () => {
  surface = await startLiveSurface({ nonSuperuser: true });
}, 180_000);

afterAll(async () => {
  await surface?.close();
}, 60_000);

const names = async (profile: string | null) => {
  const client = await surface.connectMcp(surface.apiKey, profile);
  const { tools } = await client.listTools();
  return { client, names: tools.map((t) => t.name).sort() };
};

describe("MNEMO_MCP_TOOLS on the built child", () => {
  it("unset: every tool, and they answer through the real server", async () => {
    const { client, names: listed } = await names(null);
    expect(listed).toEqual([...EXPECTED_TOOL_NAMES].sort());

    const written = await callTool(client, "memory_remember", {
      statement: "Oriel Systems bills its customers quarterly in arrears.",
      subject: "Oriel Systems",
    });
    expect(written.isError, written.text).toBe(false);
    const recalled = await callTool(client, "memory_recall", {
      query: "Oriel Systems billing quarterly",
    });
    expect(recalled.isError, recalled.text).toBe(false);
    expect(recalled.text).toContain(written.structured?.id as string);

    const timeline = await callTool(client, "memory_timeline", { limit: 5 });
    expect(timeline.isError, timeline.text).toBe(false);
  });

  it("full: the same, every tool", async () => {
    expect((await names("full")).names).toEqual([...EXPECTED_TOOL_NAMES].sort());
  });

  it("core: the nine, and a tool outside them is refused", async () => {
    const { client, names: listed } = await names("core");
    expect(listed).toEqual(CORE);
    const outside = await callTool(client, "memory_timeline", { limit: 5 }).catch((e: Error) => ({
      isError: true,
      text: e.message,
    }));
    expect(outside.isError).toBe(true);
  });
});
