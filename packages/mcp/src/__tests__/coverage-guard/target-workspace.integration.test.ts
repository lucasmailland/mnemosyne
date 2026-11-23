/**
 * p57 task F.4 — the cross-workspace write, against real Postgres.
 *
 * Everything else about `targetWorkspaceId` is covered by unit and contract
 * tests: that each of the 10 tools accepts the field, forwards it, and behaves
 * byte-identically when it is omitted. Those all run against stubs, and a stub
 * cannot answer the only question that matters here — did the row actually
 * land in the OTHER workspace, and is it invisible from this one?
 *
 * That question is answered by Postgres RLS, not by TypeScript. F.4 was marked
 * optional "if an integration environment is available". It is available, and
 * this is the one item in p57's final checklist whose failure would be a real
 * data-isolation bug rather than a documentation slip, so it is not skipped.
 *
 * What runs:
 *   1. A write member of workspace B, writing from a key bound to A with
 *      `targetWorkspaceId: B` — the row reports B as its workspace, and is NOT
 *      visible when reading as A. Both halves are needed: "the server said B"
 *      without "and A cannot see it" would pass against a route that wrote the
 *      row into A and merely echoed B back.
 *   2. A caller with no membership in B is refused, and writes nothing —
 *      neither into B nor, by silent fallback, into A. A rejected
 *      cross-workspace write that quietly lands at home is worse than an
 *      error: the fact exists, in the wrong place, and nobody was told.
 *   3. Omitting the field writes into A, unchanged.
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

/**
 * A unique, NON-NUMERIC marker.
 *
 * A timestamp was the obvious choice and it silently broke every exact-match
 * assertion in this file: the PII redactor stores 13 consecutive digits as
 * `[REDACTED-phone]`, so the fact came back with a different statement than
 * the one written. Its pattern —
 * `(?:\+?\d{1,3}[\s-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}` — matches ANY
 * run of 10+ digits, timestamp or order id or plain large number. Recorded as
 * P119 in docs/archive/BACKLOG.md; not fixed here, because loosening PII detection is
 * a security decision and not a test fixture's call to make.
 */
function marker(): string {
  // Uniqueness ACROSS runs is the requirement here, not repeatability: these tests
  // write into a database that outlives the run, so a fixed marker would collide
  // with the previous run's rows.
  return `mk-${Math.random().toString(36).slice(2, 10)}`; // determinism-ok: see above
}

/** Authenticated as userA, who will be made a write member of workspace B. */
function asUserA(method: string, path: string, body?: unknown): Promise<Response> {
  return surface.http(method, path, {
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${surface.secondaryIdentities.userA.apiKey}`,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("p57 F.4 — targetWorkspaceId against real Postgres", () => {
  let workspaceB: string;

  beforeAll(async () => {
    const created = await callTool(surface.mcp, "memory_workspace", {
      action: "create",
      name: "p57 F.4 target",
      tenantId: surface.secondaryIdentities.tenantId,
    });
    workspaceB = (created.structuredContent as { workspace: { id: string } }).workspace.id;
    expect(workspaceB).toBeTruthy();

    // Tenant membership first, then workspace membership — the invite checks
    // the former (see tools-relocate.integration.test.ts for the same order).
    await surface.http("POST", `/tenants/${surface.secondaryIdentities.tenantId}/members`, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "live-surface-admin-a@example.com", role: "member" }),
    });
    const invited = await callTool(surface.mcp, "memory_workspace", {
      action: "invite",
      workspaceId: workspaceB,
      userId: surface.secondaryIdentities.userA.id,
      role: "write",
    });
    expect(invited.isError, JSON.stringify(invited)).toBeFalsy();
  }, 60_000);

  it("a write member's row lands in B and is invisible from A", async () => {
    const statement = `p57 F.4 cross-workspace write ${marker()}`;
    const res = await asUserA("POST", "/remember", {
      statement,
      subject: "workspace",
      targetWorkspaceId: workspaceB,
    });
    expect(res.status).toBeLessThan(300);

    const fact = (await json(res)) as { id: string; workspaceId: string };
    // The server's own account of where it wrote.
    expect(fact.workspaceId).toBe(workspaceB);

    // ...and the account Postgres gives, which is the one that counts. Reading
    // as A must not find it. If this passes while the assertion above fails,
    // the row went to A and B was only echoed back.
    const fromA = await surface.http("GET", `/facts/${fact.id}`);
    expect([403, 404]).toContain(fromA.status);

    // CONTROL. Without this the assertion above is worthless: a route that
    // 404s for every id would "prove" isolation while proving nothing. Write
    // a fact into A by the same path and confirm A can read THAT one.
    const local = await asUserA("POST", "/remember", {
      statement: `p57 F.4 control, belongs to A ${marker()}`,
      subject: "workspace",
    });
    const localFact = (await json(local)) as { id: string; workspaceId: string };
    expect(localFact.workspaceId).toBe(surface.workspaceId);
    const readLocal = await surface.http("GET", `/facts/${localFact.id}`);
    expect(readLocal.status).toBe(200);
  }, 60_000);

  it("a non-member is refused, and nothing is written anywhere", async () => {
    // In userA's own tenant, but userA is never invited into it: tenant
    // membership alone must not open a workspace. (A workspace in a fresh
    // tenant cannot be made here: since AUTH-TENANT-NULL the harness key acts
    // only in its home tenant, not in one it just created.)
    const strangerWs = await callTool(surface.mcp, "memory_workspace", {
      action: "create",
      name: "p57 F.4 stranger",
      tenantId: surface.secondaryIdentities.tenantId,
    });
    const strangerId = (strangerWs.structuredContent as { workspace: { id: string } }).workspace.id;

    const statement = `p57 F.4 must not be written ${marker()}`;
    const res = await asUserA("POST", "/remember", {
      statement,
      subject: "workspace",
      targetWorkspaceId: strangerId,
    });
    expect(res.status).toBe(403);

    // The silent-fallback check: a refused cross-workspace write must not have
    // landed at home instead.
    // Listed and filtered here rather than queried with `?q=`: the question is
    // "is the row there", not "does FTS work". `q` runs plainto_tsquery against
    // `text_lemmatized`, which the outbox populates ASYNCHRONOUSLY — a write
    // read back immediately finds nothing, and the check would have reported a
    // clean absence for a fact that was sitting right there.
    const listed = await surface.http("GET", "/facts?limit=100&status=all");
    expect(listed.status).toBe(200);
    const body = (await json(listed)) as { items: Array<{ statement?: string }> };
    expect(body.items.some((f) => f.statement === statement)).toBe(false);

    // CONTROL: the listing must be able to SEE a fact of A's, or "not present"
    // says nothing at all. This control earned its keep twice already — it
    // caught `GET /search` not existing (that check was 404ing and skipping
    // itself) and then that the key is `items`, not `results`.
    const present = `p57 F.4 findable ${marker()}`;
    await asUserA("POST", "/remember", { statement: present, subject: "workspace" });
    const after = await surface.http("GET", "/facts?limit=100&status=all");
    const afterBody = (await json(after)) as { items: Array<{ statement?: string }> };
    expect(afterBody.items.some((f) => f.statement === present)).toBe(true);
  }, 60_000);

  it("omitting the field writes into the key's own workspace", async () => {
    const statement = `p57 F.4 no target ${marker()}`;
    const res = await asUserA("POST", "/remember", { statement, subject: "workspace" });
    expect(res.status).toBeLessThan(300);

    const fact = (await json(res)) as { workspaceId: string };
    expect(fact.workspaceId).toBe(surface.workspaceId);
  }, 60_000);
});
