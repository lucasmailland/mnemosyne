/**
 * Plan 7.3 (audit 2026-11-22) — the MCP round trip with the app connected as
 * production connects: a NOSUPERUSER NOBYPASSRLS login role provisioned by the
 * real `docker/scripts/provision-app-role.mjs` (`startLiveSurface({ nonSuperuser:
 * true })`). Every other MCP integration file ran the server as the container's
 * superuser, which bypasses RLS and any missing grant.
 *
 * Ported from the 2026-11-22 audit script `mcp-live.mjs` (not in the repo): remember,
 * duplicate remember, fact by id (known, unknown), recall, search, update
 * (bitemporal replace), decide + fact by kind, forget, recall after forget.
 *
 * No LLM (deps.llm undefined) and a deterministic fake embedder: no network.
 * Requires Docker + the builds listed in `./harness/live-surface.ts`.
 */
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APP_ROLE, callTool, startLiveSurface, type LiveSurface } from "./harness/live-surface.js";

const STATEMENT = "Larkspur Robotics prefers all customer communication in Spanish.";

let surface: LiveSurface;
let admin: postgres.Sql;

beforeAll(async () => {
  surface = await startLiveSurface({ nonSuperuser: true });
  admin = postgres(surface.databaseUrl, { max: 1, onnotice: () => void 0 });
}, 180_000);

afterAll(async () => {
  await admin?.end();
  await surface?.close();
}, 60_000);

const memories = (structured: Record<string, unknown> | undefined) =>
  (structured?.memories ?? []) as Array<{ id?: string; content?: string }>;

describe("MCP through the non-superuser app role", () => {
  it("every app connection is the provisioned NOSUPERUSER NOBYPASSRLS role", async () => {
    const [role] = await admin<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = ${APP_ROLE}
    `;
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });

    // A call that opens the app's pools: key lookup, storage, metrics client.
    const status = await callTool(surface.mcp, "memory_context");
    expect(status.isError, status.text).toBe(false);

    const rows = await admin<Array<{ usename: string }>>`
      SELECT DISTINCT usename FROM pg_stat_activity
      WHERE datname = 'mnemo' AND backend_type = 'client backend' AND pid <> pg_backend_pid()
    `;
    expect(rows.map((r) => r.usename)).toEqual([APP_ROLE]);
  });

  it("remember -> recall -> forget round trip", async () => {
    const remembered = await callTool(surface.mcp, "memory_remember", {
      statement: STATEMENT,
      subject: "Larkspur Robotics",
      subtype: "preference",
    });
    expect(remembered.isError, remembered.text).toBe(false);
    const id = remembered.structured?.id as string;
    expect(id).toBeTruthy();

    // An exact re-assert is deduplicated to the same row (mcp-live "duplicate").
    const again = await callTool(surface.mcp, "memory_remember", {
      statement: STATEMENT,
      subject: "Larkspur Robotics",
      subtype: "preference",
    });
    expect(again.isError, again.text).toBe(false);
    expect(again.structured?.id).toBe(id);

    const fact = await callTool(surface.mcp, "memory_fact", { factId: id });
    expect(fact.isError, fact.text).toBe(false);
    expect(fact.text).toContain(STATEMENT);

    const recalled = await callTool(surface.mcp, "memory_recall", {
      query: "Larkspur customer communication Spanish",
      limit: 5,
    });
    expect(recalled.isError, recalled.text).toBe(false);
    expect(memories(recalled.structured).some((m) => m.id === id)).toBe(true);

    const searched = await callTool(surface.mcp, "memory_search", {
      query: "Larkspur Spanish",
      limit: 5,
    });
    expect(searched.isError, searched.text).toBe(false);
    expect(searched.text).toContain(id);

    const forgotten = await callTool(surface.mcp, "memory_forget", {
      factId: id,
      reason: "integration round trip",
    });
    expect(forgotten.isError, forgotten.text).toBe(false);
    expect(forgotten.structured).toMatchObject({ id, forgotten: true });

    const after = await callTool(surface.mcp, "memory_recall", {
      query: "Larkspur customer communication Spanish",
      limit: 5,
    });
    expect(after.isError, after.text).toBe(false);
    expect(memories(after.structured).some((m) => m.id === id)).toBe(false);

    // forget closes validity, it does not delete: the row is still readable by id, marked closed.
    const closed = await callTool(surface.mcp, "memory_fact", { factId: id });
    expect(closed.isError, closed.text).toBe(false);
    expect(closed.structured?.validTo).toBeTruthy();
    const [row] = await admin<Array<{ valid_to: Date | null }>>`
      SELECT valid_to FROM mnemosyne.mnemo_fact WHERE id = ${id}
    `;
    expect(row?.valid_to).not.toBeNull();
  });

  it("memory_fact on an unknown id is a not-found tool error", async () => {
    const missing = await callTool(surface.mcp, "memory_fact", {
      factId: "00000000-0000-4000-8000-00000000dead",
    });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("status=404");
  });

  it("memory_update replaces a fact bitemporally: the old id closes, the new one is served", async () => {
    const original = await callTool(surface.mcp, "memory_remember", {
      statement: "The staging database runs Postgres 17 with pgvector on port 5544.",
      subject: "staging database",
      subtype: "config",
    });
    expect(original.isError, original.text).toBe(false);
    const oldId = original.structured?.id as string;

    const updated = await callTool(surface.mcp, "memory_update", {
      factId: oldId,
      statement: "The staging database runs Postgres 17 with pgvector on port 5545.",
      reason: "port changed",
    });
    expect(updated.isError, updated.text).toBe(false);

    const [current] = await admin<Array<{ id: string }>>`
      SELECT id FROM mnemosyne.mnemo_fact
      WHERE statement LIKE '%port 5545%' AND valid_to IS NULL
    `;
    expect(current?.id).toBeTruthy();
    expect(current!.id).not.toBe(oldId);

    const old = await callTool(surface.mcp, "memory_fact", { factId: oldId });
    expect(old.isError, old.text).toBe(false);
    expect(old.structured?.validTo).toBeTruthy();
  });

  it("memory_decide writes a decision that memory_fact reads back by kind", async () => {
    const decided = await callTool(surface.mcp, "memory_decide", {
      kind: "architecture",
      title: "Use pgvector HNSW over a dedicated vector DB",
      body: "One Postgres keeps RLS and vectors together; revisit above 50M facts.",
    });
    expect(decided.isError, decided.text).toBe(false);
    const id = decided.structured?.id as string;
    expect(id).toBeTruthy();

    const read = await callTool(surface.mcp, "memory_fact", { factId: id, kind: "decision" });
    expect(read.isError, read.text).toBe(false);
    expect(read.text).toContain("pgvector HNSW");
  });
});
