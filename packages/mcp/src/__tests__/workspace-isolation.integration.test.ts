/**
 * Plan 7.3 (audit 2026-11-22) — workspace isolation through the MCP surface,
 * app connected as the non-superuser role. Two workspaces in the SAME tenant,
 * two workspace keys with the same full scope set: the only thing that differs
 * is the home workspace, so nothing but the workspace boundary can explain a
 * refusal. B must never read, change or move A's memory; by id it gets 404.
 *
 * Requires Docker + the builds listed in `./harness/live-surface.ts`.
 */
import postgres from "postgres";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ALL_SCOPES,
  callTool,
  startLiveSurface,
  type LiveSurface,
} from "./harness/live-surface.js";

const WS_B = "c3d4e5f6-a7b8-4901-8cde-f12345678902";
const KEY_B = "mns_live_livesurfaceworkspacebkey01";

const SECRET_A = "Quillon Freight renegotiates its carrier contract every April.";
const SECRET_B = "Marisol Bakery closes its ledger on the third business day.";

let surface: LiveSurface;
let admin: postgres.Sql;
let mcpB: Client;
let factA: string;

beforeAll(async () => {
  surface = await startLiveSurface({
    nonSuperuser: true,
    extraKeys: [{ key: KEY_B, workspaceId: WS_B, scopes: ALL_SCOPES }],
  });
  admin = postgres(surface.databaseUrl, { max: 1, onnotice: () => void 0 });
  mcpB = await surface.connectMcp(KEY_B);

  const remembered = await callTool(surface.mcp, "memory_remember", {
    statement: SECRET_A,
    subject: "Quillon Freight",
  });
  if (remembered.isError) throw new Error(`seed remember failed: ${remembered.text}`);
  factA = remembered.structured?.id as string;
}, 180_000);

afterAll(async () => {
  await admin?.end();
  await surface?.close();
}, 60_000);

const liveRow = async (id: string) => {
  const [row] = await admin<
    Array<{ workspace_id: string; statement: string; valid_to: Date | null }>
  >`
    SELECT workspace_id, statement, valid_to FROM mnemosyne.mnemo_fact WHERE id = ${id}
  `;
  return row;
};

describe("workspace B never reaches workspace A's memory", () => {
  it("B's key is bound to B's workspace", async () => {
    const ctx = await callTool(mcpB, "memory_context", { includeStats: false });
    expect(ctx.isError, ctx.text).toBe(false);
    expect((ctx.structured?.workspace as { id?: string } | null)?.id).toBe(WS_B);
  });

  it("recall in every mode returns none of A's facts", async () => {
    for (const mode of ["auto", "lexical", "semantic", "hybrid"] as const) {
      const r = await callTool(mcpB, "memory_recall", {
        query: "Quillon Freight carrier contract April",
        mode,
        limit: 25,
      });
      expect(r.isError, `${mode}: ${r.text}`).toBe(false);
      expect(r.text, mode).not.toContain(factA);
      expect(r.text, mode).not.toContain("Quillon");
    }
  });

  it("search returns none of A's facts", async () => {
    const r = await callTool(mcpB, "memory_search", {
      query: "Quillon Freight carrier",
      limit: 20,
    });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).not.toContain(factA);
    expect(r.text).not.toContain("Quillon");
  });

  it("memory_fact on A's id is 404", async () => {
    const r = await callTool(mcpB, "memory_fact", { factId: factA });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("status=404");
    expect(r.text).not.toContain("Quillon");
  });

  it("forget, update and relocate of A's id are refused and A's row is untouched", async () => {
    const forgot = await callTool(mcpB, "memory_forget", { factId: factA });
    expect(forgot.isError, forgot.text).toBe(true);
    expect(forgot.text).toContain("status=404");

    const updated = await callTool(mcpB, "memory_update", {
      factId: factA,
      statement: "Quillon Freight never renegotiates.",
    });
    expect(updated.isError, updated.text).toBe(true);
    expect(updated.text).toMatch(/status=40[34]/);

    const moved = await callTool(mcpB, "memory_relocate", {
      factId: factA,
      targetWorkspaceId: WS_B,
    });
    expect(moved.isError, moved.text).toBe(true);
    expect(moved.text).toMatch(/status=40[34]/);

    const row = await liveRow(factA);
    expect(row).toMatchObject({
      workspace_id: surface.workspaceId,
      statement: SECRET_A,
      valid_to: null,
    });
    const [counted] = await admin<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM mnemosyne.mnemo_fact WHERE statement LIKE 'Quillon Freight never%'
    `;
    expect(counted?.n).toBe(0);
  });

  it("B cannot write into A's workspace with targetWorkspaceId", async () => {
    const r = await callTool(mcpB, "memory_remember", {
      statement: "Quillon Freight was written here by workspace B.",
      targetWorkspaceId: surface.workspaceId,
    });
    expect(r.isError, r.text).toBe(true);
    expect(r.text).toMatch(/status=40[34]/);
    const [counted] = await admin<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM mnemosyne.mnemo_fact WHERE statement LIKE '%written here by workspace B%'
    `;
    expect(counted?.n).toBe(0);
  });

  it("the other way round: A does not see what B remembers", async () => {
    const written = await callTool(mcpB, "memory_remember", {
      statement: SECRET_B,
      subject: "Marisol Bakery",
    });
    expect(written.isError, written.text).toBe(false);
    const factB = written.structured?.id as string;
    expect((await liveRow(factB))?.workspace_id).toBe(WS_B);

    const r = await callTool(surface.mcp, "memory_recall", {
      query: "Marisol Bakery ledger business day",
      limit: 25,
    });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).not.toContain(factB);
    const byId = await callTool(surface.mcp, "memory_fact", { factId: factB });
    expect(byId.isError).toBe(true);
    expect(byId.text).toContain("status=404");

    // and A still recalls its own fact
    const own = await callTool(surface.mcp, "memory_recall", {
      query: "Quillon Freight carrier contract April",
      limit: 5,
    });
    expect(own.text).toContain(factA);
  });
});
