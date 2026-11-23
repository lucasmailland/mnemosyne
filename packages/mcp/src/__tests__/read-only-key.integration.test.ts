/**
 * Plan 7.3 (audit 2026-11-22) — a `memory:read`-only key through the MCP child
 * a user gets by default (no MNEMO_MCP_TOOLS, the full profile), against the
 * real server running as the non-superuser role. Reads work; every write tool
 * of the core set is refused with a tool error naming the 403, and the
 * refused write leaves the database unchanged.
 *
 * Requires Docker + the builds listed in `./harness/live-surface.ts`.
 */
import postgres from "postgres";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  HARNESS_WORKSPACE_ID,
  callTool,
  startLiveSurface,
  type LiveSurface,
} from "./harness/live-surface.js";
import { MCP_TOOL_COUNT } from "../registry.js";

const READ_KEY = "mns_live_livesurfacereadonlykey0001";
const STATEMENT = "Tamsin Labs ships firmware updates only on Tuesdays.";

let surface: LiveSurface;
let admin: postgres.Sql;
let reader: Client;
let factId: string;

beforeAll(async () => {
  surface = await startLiveSurface({
    nonSuperuser: true,
    extraKeys: [{ key: READ_KEY, workspaceId: HARNESS_WORKSPACE_ID, scopes: ["memory:read"] }],
  });
  admin = postgres(surface.databaseUrl, { max: 1, onnotice: () => void 0 });
  // null: MNEMO_MCP_TOOLS unset, the profile a user gets by default.
  reader = await surface.connectMcp(READ_KEY, null);

  const written = await callTool(surface.mcp, "memory_remember", {
    statement: STATEMENT,
    subject: "Tamsin Labs",
  });
  if (written.isError) throw new Error(`seed remember failed: ${written.text}`);
  factId = written.structured?.id as string;
}, 180_000);

afterAll(async () => {
  await admin?.end();
  await surface?.close();
}, 60_000);

const factCount = async () => {
  const [counted] = await admin<
    Array<{ n: number }>
  >`SELECT count(*)::int AS n FROM mnemosyne.mnemo_fact`;
  return counted!.n;
};

describe("a memory:read key over the default MCP profile", () => {
  it("serves the full profile", async () => {
    const { tools } = await reader.listTools();
    expect(tools.map((t) => t.name)).toContain("memory_remember");
    expect(tools).toHaveLength(MCP_TOOL_COUNT);
  });

  it("recall, search and fact by id work", async () => {
    const recalled = await callTool(reader, "memory_recall", {
      query: "Tamsin Labs firmware Tuesdays",
      limit: 5,
    });
    expect(recalled.isError, recalled.text).toBe(false);
    expect(recalled.text).toContain(factId);

    const searched = await callTool(reader, "memory_search", {
      query: "Tamsin firmware",
      limit: 5,
    });
    expect(searched.isError, searched.text).toBe(false);
    expect(searched.text).toContain(factId);

    const fact = await callTool(reader, "memory_fact", { factId });
    expect(fact.isError, fact.text).toBe(false);
    expect(fact.text).toContain(STATEMENT);
  });

  it("memory_remember is refused with a clear tool error and stores nothing", async () => {
    const before = await factCount();
    const r = await callTool(reader, "memory_remember", {
      statement: "Tamsin Labs moved firmware updates to Thursdays.",
      subject: "Tamsin Labs",
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("memory_remember failed");
    expect(r.text).toContain("status=403");
    expect(r.text).toContain("memory:write");
    expect(await factCount()).toBe(before);
  });

  it("memory_decide, memory_update and memory_forget are refused and the fact is untouched", async () => {
    const decided = await callTool(reader, "memory_decide", {
      kind: "decision",
      title: "Ship firmware on Thursdays",
      body: "Read-only keys must not record decisions.",
    });
    expect(decided.isError, decided.text).toBe(true);
    expect(decided.text).toContain("status=403");

    const updated = await callTool(reader, "memory_update", {
      factId,
      statement: "Tamsin Labs ships firmware updates daily.",
    });
    expect(updated.isError, updated.text).toBe(true);
    expect(updated.text).toContain("status=403");

    const forgot = await callTool(reader, "memory_forget", { factId });
    expect(forgot.isError, forgot.text).toBe(true);
    expect(forgot.text).toContain("status=403");

    const [row] = await admin<Array<{ statement: string; valid_to: Date | null }>>`
      SELECT statement, valid_to FROM mnemosyne.mnemo_fact WHERE id = ${factId}
    `;
    expect(row).toEqual({ statement: STATEMENT, valid_to: null });
    const [counted] = await admin<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM mnemosyne.mnemo_decision WHERE title = 'Ship firmware on Thursdays'
    `;
    expect(counted?.n).toBe(0);
  });
});
