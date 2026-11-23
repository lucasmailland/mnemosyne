/**
 * Plan 7.3 (audit 2026-11-22) — sensitivity ceiling through the MCP surface,
 * app connected as the non-superuser role. A key with `max_sensitivity =
 * internal` in the SAME workspace as a `confidential` fact never sees it:
 * recall (every mode), search, timeline, fact by id (404, anti-probing), and it
 * cannot forget or update it either.
 *
 * Ported from the 2026-11-22 audit script `verify-ceiling.mjs` (not in the repo)
 * (APP-008: forget ignored the ceiling) and the APP-009 live check (a low
 * ceiling re-asserting the same text must not get the protected row's id).
 * The WebSocket/webhook half of verify-ceiling.mjs and verify-ws.mjs (APP-006,
 * APP-030) is not an MCP surface; it is covered in packages/server by
 * ws-ceiling.test.ts, webhookDispatch.test.ts and the ws e2e test.
 *
 * The fake embedder gives every text the same vector, so a semantic recall
 * that skipped the ceiling filter would return the confidential fact first.
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

const LOW_KEY = "mns_live_livesurfaceinternalceil001";
const SECRET = "CONFIDENTIAL-CANARY-4417: the Halvard acquisition closes on March 3.";

let surface: LiveSurface;
let admin: postgres.Sql;
let low: Client;
let secretId: string;

const priorCeiling = process.env.MNEMO_SENSITIVITY_CEILING;

beforeAll(async () => {
  // The server-wide ceiling defaults to `internal`; the per-key grant can only
  // lower it. Raised so the harness key may hold a confidential fact at all.
  process.env.MNEMO_SENSITIVITY_CEILING = "restricted";
  surface = await startLiveSurface({
    nonSuperuser: true,
    extraKeys: [
      {
        key: LOW_KEY,
        workspaceId: HARNESS_WORKSPACE_ID,
        // memory_update needs memory:self_edit: granted so the ceiling is the only refusal left.
        scopes: ["memory:read", "memory:write", "memory:delete", "memory:self_edit"],
        maxSensitivity: "internal",
      },
    ],
  });
  admin = postgres(surface.databaseUrl, { max: 1, onnotice: () => void 0 });
  low = await surface.connectMcp(LOW_KEY);

  // memory_remember has no sensitivity parameter; the harness key (no per-key
  // grant, so the server ceiling above) writes the confidential fact over HTTP.
  const res = await surface.http("POST", "/remember", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      statement: SECRET,
      subject: "Halvard acquisition",
      sensitivity: "confidential",
    }),
  });
  const body = (await res.json()) as { id?: string; sensitivity?: string };
  if (res.status !== 201 || !body.id) {
    throw new Error(`seed confidential remember failed: ${res.status} ${JSON.stringify(body)}`);
  }
  secretId = body.id;
}, 180_000);

afterAll(async () => {
  await admin?.end();
  await surface?.close();
  if (priorCeiling === undefined) delete process.env.MNEMO_SENSITIVITY_CEILING;
  else process.env.MNEMO_SENSITIVITY_CEILING = priorCeiling;
}, 60_000);

describe("an internal-ceiling key never sees a confidential fact", () => {
  it("control: the restricted-ceiling harness key reads it by id", async () => {
    const r = await callTool(surface.mcp, "memory_fact", { factId: secretId });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toContain("CONFIDENTIAL-CANARY-4417");
    const [row] = await admin<Array<{ sensitivity: string }>>`
      SELECT sensitivity FROM mnemosyne.mnemo_fact WHERE id = ${secretId}
    `;
    expect(row?.sensitivity).toBe("confidential");
  });

  it("recall in every mode, search and timeline leave it out", async () => {
    for (const mode of ["auto", "lexical", "semantic", "hybrid"] as const) {
      const r = await callTool(low, "memory_recall", {
        query: "Halvard acquisition closes",
        mode,
        limit: 25,
      });
      expect(r.isError, `${mode}: ${r.text}`).toBe(false);
      expect(r.text, mode).not.toContain(secretId);
      expect(r.text, mode).not.toContain("CANARY");
    }
    const searched = await callTool(low, "memory_search", {
      query: "Halvard acquisition",
      limit: 20,
    });
    expect(searched.isError, searched.text).toBe(false);
    expect(searched.text).not.toContain(secretId);
    expect(searched.text).not.toContain("CANARY");

    const timeline = await callTool(low, "memory_timeline", { limit: 50 });
    expect(timeline.isError, timeline.text).toBe(false);
    expect(timeline.text).not.toContain(secretId);
    expect(timeline.text).not.toContain("CANARY");
  });

  it("memory_fact by id is 404, not 403", async () => {
    const r = await callTool(low, "memory_fact", { factId: secretId });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("status=404");
    expect(r.text).not.toContain("CANARY");
  });

  it("APP-008: forget and update of the id are 404 and the fact stays valid", async () => {
    const forgot = await callTool(low, "memory_forget", { factId: secretId });
    expect(forgot.isError, forgot.text).toBe(true);
    expect(forgot.text).toContain("status=404");

    const updated = await callTool(low, "memory_update", {
      factId: secretId,
      statement: "The Halvard acquisition was cancelled.",
    });
    expect(updated.isError, updated.text).toBe(true);
    expect(updated.text).toContain("status=404");

    const [row] = await admin<Array<{ valid_to: Date | null }>>`
      SELECT valid_to FROM mnemosyne.mnemo_fact WHERE id = ${secretId}
    `;
    expect(row?.valid_to).toBeNull();
  });

  it("APP-009: re-asserting the same text does not hand back the confidential row's id", async () => {
    const r = await callTool(low, "memory_remember", {
      statement: SECRET,
      subject: "Halvard acquisition",
    });
    expect(r.isError, r.text).toBe(false);
    expect(r.structured?.id).toBeTruthy();
    expect(r.structured?.id).not.toBe(secretId);
    expect(r.text).not.toContain(secretId);
  });
});
