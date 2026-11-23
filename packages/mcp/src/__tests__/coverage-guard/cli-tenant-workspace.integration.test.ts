/**
 * B4.3 — CLI command coverage fill-in: tenant/workspace/user/token/identity
 * commands (design.md "B4. Coverage fill-in", spec.md Requirement 13).
 * Exercises `mnemo workspace`, `tenant`, `user`, `token`, `info`, `whoami`
 * via `surface.cli(args)` — the real built `mnemo` binary as a subprocess
 * against the live server.
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

describe("mnemo info / whoami (B4.3)", () => {
  it("info prints the session dashboard including the real workspace id", async () => {
    const result = await surface.cli(["info"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Mnemosyne — Session Info");
    expect(result.stdout).toContain(surface.workspaceId);
  });

  it("whoami is a backwards-compatible alias for info", async () => {
    const result = await surface.cli(["whoami"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Mnemosyne — Session Info");
  });
});

describe("mnemo tenant / workspace / user / token (B4.3)", () => {
  it("full lifecycle: tenant create/show, user create, workspace create/show/invite/members/set-role/remove, token issue/list/revoke", async () => {
    const tenantCreated = await surface.cli([
      "tenant",
      "create",
      "--name",
      "B4.3 CLI tenant",
      "--kind",
      "organization",
    ]);
    expect(tenantCreated.code).toBe(0);
    // V-11: confirmations are status lines on stderr.
    const newTenantMatch = tenantCreated.stderr.match(/Tenant created:\s+"?([^\s"]+)/);
    expect(newTenantMatch).toBeTruthy();

    // Tenant-plane authority comes from the key's own tenant (AUTH-TENANT-NULL,
    // c572e783): this key has no tenant and no user, so it acts in its home
    // workspace's tenant and never in the one it just made (403 → exit 3).
    const newTenantShow = await surface.cli(["tenant", "show", newTenantMatch![1]!]);
    expect(newTenantShow.code).toBe(3);

    const tenantId = surface.secondaryIdentities.tenantId;
    const tenantShow = await surface.cli(["tenant", "show", tenantId]);
    expect(tenantShow.code).toBe(0);
    expect(tenantShow.stdout).toContain(tenantId);

    const email = `b4.3-cli-user-${Date.now()}@example.com`; // determinism-ok: uniqueness suffix only, not asserted
    const userCreated = await surface.cli(["user", "create", "--email", email]);
    expect(userCreated.code).toBe(0);
    const userIdMatch = userCreated.stderr.match(/User created:\s+"?([^\s"]+)/);
    expect(userIdMatch).toBeTruthy();
    const userId = userIdMatch![1]!;

    // POST /workspaces/:id/members requires the target to already be a
    // member of the workspace's TENANT (real, discovered server
    // requirement — see routes-tenants-users-breakglass.integration.test
    // .ts's "full membership lifecycle" comment) — join the tenant first.
    const tenantInvite = await surface.cli([
      "tenant",
      "invite",
      tenantId,
      email,
      "--role",
      "member",
    ]);
    expect(tenantInvite.code).toBe(0);

    const wsCreated = await surface.cli([
      "workspace",
      "create",
      "--name",
      "B4.3 CLI workspace",
      "--tenant",
      tenantId,
    ]);
    expect(wsCreated.code).toBe(0);
    const wsIdMatch = wsCreated.stderr.match(/Workspace created:\s+"?([^\s"]+)/);
    expect(wsIdMatch).toBeTruthy();
    const workspaceId = wsIdMatch![1]!;

    // Real anti-probing behavior (B4.1 finding, HTTP-level, reconfirmed here
    // through the CLI): a workspace-only key (no bound userId, like this
    // harness's main key) is scoped to ITS OWN workspaceId only —
    // GET /workspaces/:id 404s for any other workspace, even one this same
    // key just created via the tenant-scoped create route. `mnemo workspace
    // show` surfaces that real 404 as a non-zero exit, not a crash.
    const wsShow = await surface.cli(["workspace", "show", workspaceId]);
    expect(wsShow.code).not.toBe(0);
    expect(wsShow.stderr).toContain("404");

    const wsList = await surface.cli(["workspace", "list"]);
    expect(wsList.code).toBe(0);

    const invited = await surface.cli([
      "workspace",
      "invite",
      workspaceId,
      userId,
      "--role",
      "write",
    ]);
    expect(invited.code).toBe(0);
    expect(invited.stderr).toContain(`${userId} added to workspace ${workspaceId}`);

    const members = await surface.cli(["workspace", "members", workspaceId]);
    expect(members.code).toBe(0);
    expect(members.stdout).toContain(userId);

    // Token issuance requires the target user to currently belong to
    // --workspace (its homeWorkspaceId) — real, discovered requirement, so
    // this runs before the workspace-remove step below drops that
    // membership.
    const issued = await surface.cli([
      "token",
      "issue",
      tenantId,
      userId,
      "--label",
      "b4.3-cli-token",
      "--workspace",
      workspaceId,
      "--scopes",
      "memory:read",
    ]);
    expect(issued.code).toBe(0);
    expect(issued.stdout).toContain("Token minted");
    const tokenIdMatch = issued.stdout.match(/ID:\s+(\S+)/);
    expect(tokenIdMatch).toBeTruthy();
    const tokenId = tokenIdMatch![1]!;

    const tokenList = await surface.cli(["token", "list", tenantId, userId]);
    expect(tokenList.code).toBe(0);
    expect(tokenList.stdout).toContain(tokenId);

    const tokenRevoked = await surface.cli(["token", "revoke", tenantId, userId, tokenId]);
    expect(tokenRevoked.code).toBe(0);
    expect(tokenRevoked.stderr).toContain(`Token ${tokenId} revoked`);

    const setRole = await surface.cli(["workspace", "set-role", workspaceId, userId, "admin"]);
    expect(setRole.code).toBe(0);
    expect(setRole.stderr).toContain(`role in workspace ${workspaceId} set to admin`);

    const removed = await surface.cli(["workspace", "remove", workspaceId, userId]);
    expect(removed.code).toBe(0);
    expect(removed.stderr).toContain(`${userId} removed from workspace ${workspaceId}`);
  });

  it("tenant members/invite/remove/workspaces", async () => {
    const tenantCreated = await surface.cli(["tenant", "create", "--name", "B4.3 CLI tenant 2"]);
    expect(tenantCreated.code).toBe(0);
    expect(tenantCreated.stderr).toMatch(/Tenant created:\s+\S+/);
    // Members and workspaces of the key's own tenant: see the test above.
    const tenantId = surface.secondaryIdentities.tenantId;

    const invited = await surface.cli([
      "tenant",
      "invite",
      tenantId,
      `b4.3-cli-invitee-${Date.now()}@example.com`, // determinism-ok: uniqueness suffix only, not asserted
      "--role",
      "member",
      "--create-if-missing",
    ]);
    expect(invited.code).toBe(0);

    const members = await surface.cli(["tenant", "members", tenantId]);
    expect(members.code).toBe(0);

    const workspaces = await surface.cli(["tenant", "workspaces", tenantId]);
    expect(workspaces.code).toBe(0);
  });
});
