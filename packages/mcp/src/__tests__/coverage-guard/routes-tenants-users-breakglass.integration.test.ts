/**
 * B4.1 — HTTP route coverage fill-in: tenant/user/workspace admin routes and
 * the WP8 break-glass dual-control surface (design.md "B4. Coverage fill-in",
 * spec.md Requirement 13).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startLiveSurface, type LiveSurface } from "../harness/live-surface.js";

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

function authedFetch(baseUrl: string, apiKey: string) {
  return (method: string, path: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${apiKey}`);
    return fetch(`${baseUrl}${path}`, { ...init, method, headers });
  };
}

describe("tenants/users/workspaces routes (B4.1)", () => {
  it("POST /tenants, GET /tenants/:id, POST/GET/DELETE /tenants/:id/members", async () => {
    const createRes = await surface.http("POST", "/tenants", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "B4.1 tenant", kind: "organization" }),
    });
    expect(createRes.status).toBe(201);
    const tenant = await json(createRes);
    expect(tenant.id).toBeTruthy();

    // Tenant-plane authority comes from the key's own tenant (AUTH-TENANT-NULL,
    // c572e783): a key with no tenant and no user acts in its home workspace's
    // tenant, never in the one it just made. Only a user-bound caller's
    // issueOwnerToken reaches the new tenant.
    const getNewRes = await surface.http("GET", `/tenants/${tenant.id}`);
    expect(getNewRes.status).toBe(403);

    const home = surface.secondaryIdentities.tenantId;
    const getRes = await surface.http("GET", `/tenants/${home}`);
    expect(getRes.status).toBe(200);

    const user = await json(
      await surface.http("POST", "/users", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "b4.1-member@example.com" }),
      })
    );
    expect(user.user.id).toBeTruthy();

    const inviteRes = await surface.http("POST", `/tenants/${home}/members`, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "b4.1-member@example.com", role: "member" }),
    });
    expect(inviteRes.status).toBe(200);

    const membersRes = await surface.http("GET", `/tenants/${home}/members`);
    expect(membersRes.status).toBe(200);
    const members = await json(membersRes);
    expect(members.members.some((m: any) => m.userId === user.user.id)).toBe(true);

    const removeRes = await surface.http("DELETE", `/tenants/${home}/members/${user.user.id}`);
    expect(removeRes.status).toBe(200);
  });

  it("POST /users, GET /users/me, POST/GET /tenants/:id/workspaces, GET /workspaces/:id", async () => {
    const user = await json(
      await surface.http("POST", "/users", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "b4.1-solo@example.com", displayName: "B4.1 Solo" }),
      })
    );
    expect(user.personalTenant.id).toBeTruthy();
    expect(user.personalWorkspace.id).toBeTruthy();

    // The new user's personal tenant is not the caller's: refused, like any
    // other tenant (see the test above).
    const foreignWsRes = await surface.http(
      "POST",
      `/tenants/${user.personalTenant.id}/workspaces`,
      {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "B4.1 foreign workspace" }),
      }
    );
    expect(foreignWsRes.status).toBe(403);

    const home = surface.secondaryIdentities.tenantId;
    const wsRes = await surface.http("POST", `/tenants/${home}/workspaces`, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "B4.1 second workspace" }),
    });
    expect(wsRes.status).toBe(201);
    const ws = await json(wsRes);

    const listWsRes = await surface.http("GET", `/tenants/${home}/workspaces`);
    expect(listWsRes.status).toBe(200);
    const listWs = await json(listWsRes);
    expect(listWs.workspaces.some((w: any) => w.id === ws.id)).toBe(true);

    // B4.1 discovery, fixed this session: getWorkspaceByIdRoute's anti-probing
    // check previously only ran for a USER-BOUND key (`if (userId) { ... }`)
    // — a workspace-only key (no bound userId, like this harness's main key)
    // hit no check at all and could read ANY workspace by guessing its id.
    // Now a workspace-only key is checked against its OWN scoped workspaceId
    // (set by the auth middleware from the key itself), so a different
    // workspace correctly 404s...
    const getWsRes = await surface.http("GET", `/workspaces/${ws.id}`);
    expect(getWsRes.status).toBe(404);

    // ...and its own reads (the harness seeds a real row for it).
    const getOwnRes = await surface.http("GET", `/workspaces/${surface.workspaceId}`);
    expect(getOwnRes.status).toBe(200);
  });

  it("GET /users/me — resolves the current user from a user-bound key", async () => {
    const { userA } = surface.secondaryIdentities;
    const asA = authedFetch(surface.baseUrl, userA.apiKey);
    const res = await asA("GET", "/users/me");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.id).toBe(userA.id);
  });

  it("GET /users/me — 404 for a workspace-only key with no bound userId", async () => {
    const res = await surface.http("GET", "/users/me");
    expect(res.status).toBe(404);
  });

  it("POST/GET/PATCH/DELETE /workspaces/:workspaceId/members — full membership lifecycle", async () => {
    // The caller's own tenant: a key acts only there (AUTH-TENANT-NULL).
    const tenant = { id: surface.secondaryIdentities.tenantId };
    // The workspace-member invite requires the target to already belong to
    // the workspace's tenant — create the user explicitly, then invite by
    // email (TenantMemberSchema carries only userId/role/joinedAt, no
    // email, so matching-by-userId below needs this real id up front).
    const newUser = await json(
      await surface.http("POST", "/users", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "b4.1-ws-member@example.com" }),
      })
    );
    const memberUserId = newUser.user.id as string;

    const inviteRes = await surface.http("POST", `/tenants/${tenant.id}/members`, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "b4.1-ws-member@example.com", role: "member" }),
    });
    expect(inviteRes.status).toBe(200);

    const membersRes = await json(await surface.http("GET", `/tenants/${tenant.id}/members`));
    expect(membersRes.members.some((m: any) => m.userId === memberUserId)).toBe(true);

    const ws = await json(
      await surface.http("POST", `/tenants/${tenant.id}/workspaces`, {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "B4.1 members workspace" }),
      })
    );

    const addRes = await surface.http("POST", `/workspaces/${ws.id}/members`, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: memberUserId, role: "read" }),
    });
    expect(addRes.status).toBe(200);

    const listRes = await surface.http("GET", `/workspaces/${ws.id}/members`);
    expect(listRes.status).toBe(200);
    const list = await json(listRes);
    expect(list.members.some((m: any) => m.userId === memberUserId)).toBe(true);

    const patchRes = await surface.http("PATCH", `/workspaces/${ws.id}/members/${memberUserId}`, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "write" }),
    });
    expect(patchRes.status).toBe(200);

    const removeRes = await surface.http("DELETE", `/workspaces/${ws.id}/members/${memberUserId}`);
    expect(removeRes.status).toBe(200);
    const removed = await json(removeRes);
    expect(removed.ok).toBe(true);
  });

  it("GET /tenants/:tenantId/users/:userId/tokens — real tenant-role-gated response", async () => {
    // userA/userB are seeded directly into mnemo_api_keys/mnemo_user, not
    // into mnemo_tenant_member — so this genuinely exercises the "caller is
    // not a tenant owner/admin" 403 branch, a real documented response, not
    // the happy path (see user-token-provisioning.integration.test.ts for
    // the full-membership happy-path proof of this same route family).
    const { userA } = surface.secondaryIdentities;
    const asA = authedFetch(surface.baseUrl, userA.apiKey);
    const res = await asA(
      "GET",
      `/tenants/${surface.secondaryIdentities.tenantId}/users/${userA.id}/tokens`
    );
    expect(res.status).toBe(403);
  });
});

describe("break-glass dual-control routes (B4.1)", () => {
  it("POST /break-glass, GET /break-glass/:id, POST /break-glass/:id/approve", async () => {
    const { userA, userB } = surface.secondaryIdentities;
    const asA = authedFetch(surface.baseUrl, userA.apiKey);
    const asB = authedFetch(surface.baseUrl, userB.apiKey);

    const requestRes = await asA("POST", "/break-glass", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        reason: "B4.1 incident response drill",
        requestedScopes: ["memory:hard_delete"],
      }),
    });
    expect(requestRes.status).toBe(201);
    const request = await json(requestRes);
    expect(request.status).toBe("pending");

    const getRes = await asA("GET", `/break-glass/${request.id}`);
    expect(getRes.status).toBe(200);
    const got = await json(getRes);
    expect(got.status).toBe("pending");

    // Self-approval must be rejected.
    const selfApprove = await asA("POST", `/break-glass/${request.id}/approve`);
    expect(selfApprove.status).toBe(403);

    const approveRes = await asB("POST", `/break-glass/${request.id}/approve`);
    expect(approveRes.status).toBe(200);
    const approved = await json(approveRes);
    expect(approved.status).toBe("approved");
  });

  it("POST /break-glass — rejects a non-mk_admin_ key", async () => {
    const res = await surface.http("POST", "/break-glass", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "should be rejected", requestedScopes: ["memory:read"] }),
    });
    expect(res.status).toBe(403);
  });
});
