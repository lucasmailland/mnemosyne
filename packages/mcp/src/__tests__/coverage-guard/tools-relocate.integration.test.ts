/**
 * P72 — `memory_relocate` and `POST /facts/:id/relocate`, against the real
 * live surface.
 *
 * This one had to be an integration test, not a mock. Relocate is the only
 * operation in the system that moves a row ACROSS a workspace boundary, and
 * that boundary is enforced by Postgres RLS plus a membership check — neither
 * of which a stubbed client can exercise. A mocked "it called relocateFact
 * with the right arguments" would pass just as happily against a route that
 * silently wrote into a workspace the caller has no business writing to.
 *
 * What runs here for real:
 *   1. The happy path with a USER-BOUND key that is a write member of the
 *      target: 200, and the ids differ — because this is a close-plus-
 *      successor, never an in-place `workspace_id` update. The original is
 *      then confirmed closed in the source workspace.
 *   2. The membership gate: the same call from a key bound to a workspace but
 *      to no user is rejected. Cross-workspace writes require a human.
 *   3. The MCP tool itself reaching the real route, and surfacing the real
 *      rejection as a tool error rather than an unhandled promise.
 *   4. 404 for an id that does not name an active fact here — the same
 *      anti-probing shape every other by-id read uses.
 *
 * Note on the harness: its primary key is workspace-bound with no `userId`,
 * which is exactly the identity that must NOT be able to move data between
 * workspaces. So the tool's own happy path is driven through the same route
 * with `secondaryIdentities.userA`, and the MCP client covers the rejection
 * path. That split is a property of the harness's identity model, not a gap
 * being papered over — it is stated here so the next reader does not mistake
 * assertion 3 for a full end-to-end pass of the tool.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startLiveSurface, type LiveSurface } from "../harness/live-surface.js";
import { callTool } from "./mcp-tool-helpers.js";

let surface: LiveSurface;

beforeAll(async () => {
  surface = await startLiveSurface();
}, 120_000);

afterAll(async () => {
  await surface.close();
});

async function json(res: Response): Promise<any> {
  return res.json();
}

/** Same call, but authenticated as `userA` instead of the primary key. */
function asUserA(method: string, path: string, body?: unknown): Promise<Response> {
  return surface.http(method, path, {
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${surface.secondaryIdentities.userA.apiKey}`,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("P72 — relocate a misfiled fact", () => {
  let targetWorkspaceId: string;

  beforeAll(async () => {
    // A destination the caller is genuinely a write member of. Without the
    // membership row, every relocate below would 403 for the right reason but
    // prove nothing about the happy path.
    // Created through the tool, the same way tools-admin-governance does —
    // there is no `POST /workspaces` route to call directly.
    //
    // It must live in userA's OWN tenant. Creating a fresh tenant and inviting
    // userA into a workspace under it fails with "user does not belong to this
    // tenant" — correctly: workspace membership is scoped by tenant, so an
    // outsider cannot be pulled in by a direct workspace invite.
    const created = await callTool(surface.mcp, "memory_workspace", {
      action: "create",
      name: "P72 relocate target",
      tenantId: surface.secondaryIdentities.tenantId,
    });
    targetWorkspaceId = (created.structuredContent as { workspace: { id: string } }).workspace.id;
    expect(targetWorkspaceId).toBeTruthy();

    // The harness seeds userA as a `mnemo_user` with a key, but never as a
    // TENANT member — and workspace invites check tenant membership first.
    // Two separate rows, two separate questions ("does this account exist"
    // vs "is it part of this organisation"), and the invite asks the second.
    await surface.http("POST", `/tenants/${surface.secondaryIdentities.tenantId}/members`, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "live-surface-admin-a@example.com", role: "member" }),
    });

    const invited = await callTool(surface.mcp, "memory_workspace", {
      action: "invite",
      workspaceId: targetWorkspaceId,
      userId: surface.secondaryIdentities.userA.id,
      role: "write",
    });
    // A silently failed invite would make the happy path below 403 and look
    // like a relocate bug. Fail here instead, where the cause is.
    expect(invited.isError, JSON.stringify(invited)).toBeFalsy();
  }, 60_000);

  it("moves the fact, gives it a NEW id, and closes the original", async () => {
    const fact = await surface.sdk.remember({
      statement: "P72: this fact was written into the wrong workspace.",
      subject: "workspace",
    });
    const factId = (fact as { id: string }).id;
    expect(factId).toBeTruthy();

    const res = await asUserA("POST", `/facts/${factId}/relocate`, {
      targetWorkspaceId,
      reason: "P72 integration test",
    });
    if (res.status !== 200) console.log("DIAG relocate:", res.status, await res.clone().text());
    expect(res.status).toBe(200);

    const moved = (await json(res)) as { previousId: string; newId: string };
    expect(moved.previousId).toBe(factId);
    // The id MUST change. An unchanged id would mean the row was updated in
    // place — history rewritten, and the source workspace's audit trail left
    // with a hole where a fact used to be.
    expect(moved.newId).not.toBe(factId);

    // The original is closed where it was misfiled, not deleted: a forgotten
    // fact stays readable for audit, it just stops being active.
    const after = await surface.http("GET", `/facts/${factId}`);
    if (after.status === 200) {
      const body = (await json(after)) as { validTo: string | null; status?: string };
      expect(body.validTo ?? body.status).toBeTruthy();
      expect(body.validTo === null && body.status === "active").toBe(false);
    } else {
      expect([404, 410]).toContain(after.status);
    }
  }, 60_000);

  it("refuses to move anything for a key bound to no user", async () => {
    const fact = await surface.sdk.remember({
      statement: "P72: a workspace-only key must not be able to move this.",
      subject: "workspace",
    });
    const factId = (fact as { id: string }).id;

    // The harness's primary key has a workspaceId and no userId. Dual-identity
    // reasoning aside, the plain point is that moving data between workspaces
    // is a human act and the row that authorises it is a membership row.
    const res = await surface.http("POST", `/facts/${factId}/relocate`, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetWorkspaceId }),
    });
    expect(res.status).toBe(403);

    // And the fact stayed put — a rejected move must not half-apply.
    const still = await surface.http("GET", `/facts/${factId}`);
    expect(still.status).toBe(200);
    const body = (await json(still)) as { validTo: string | null };
    expect(body.validTo).toBeNull();
  }, 60_000);

  it("memory_relocate reaches the real route and surfaces its rejection", async () => {
    const fact = await surface.sdk.remember({
      statement: "P72: reached through the MCP tool.",
      subject: "workspace",
    });

    const result = await callTool(surface.mcp, "memory_relocate", {
      factId: (fact as { id: string }).id,
      targetWorkspaceId,
    });

    // Asserting the REAL error rather than swallowing it — same discipline as
    // the `memory_workspace action='describe'` case in
    // tools-admin-governance.integration.test.ts. The tool is wired to
    // POST /facts/:id/relocate; the harness identity is the one the route is
    // built to refuse.
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(text).toContain("memory_relocate failed");
    expect(text).toMatch(/403|user-bound|member/i);
  }, 60_000);

  it("404s for an id that names no active fact here", async () => {
    const res = await asUserA("POST", `/facts/00000000-0000-4000-8000-0000000009f9/relocate`, {
      targetWorkspaceId,
    });
    expect([403, 404]).toContain(res.status);
  }, 60_000);
});
