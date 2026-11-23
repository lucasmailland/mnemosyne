/**
 * L1/L2 — coverage for the workspace/tenant/user/token CLI commands added
 * to close the multi-tenancy CLI parity gap.
 *
 * Same fetch-stub approach as primitive-parity.test.ts: stub global fetch,
 * assert on the request path/method/body, don't spawn a real process.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isBanner } from "./helpers/banner-lines.js";
import { COMMANDS, createClient, setGlobalWorkspaceId } from "../commands.js";
import { expectRequest } from "./helpers/expect-request.js";

describe("CLI workspace/tenant/user/token commands", () => {
  let fetchCalls: Array<{ url: string; opts?: RequestInit }> = [];
  let consoleLogs: string[] = [];
  let consoleErrors: string[] = [];
  let exitCode: number | undefined;

  const mockConfig = { url: "http://localhost:3939", apiKey: "uk_test_abc_xyz" };

  function stubJson(body: unknown, status?: number): void {
    vi.stubGlobal("fetch", async (url: string | URL, opts?: RequestInit) => {
      fetchCalls.push({ url: String(url), opts });
      return {
        ok: true,
        status: status ?? (opts?.method === "POST" ? 201 : 200),
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => body,
        text: async () => JSON.stringify(body),
      } as unknown as Response;
    });
  }

  function stubError(status: number, message: string): void {
    vi.stubGlobal("fetch", async (url: string | URL, opts?: RequestInit) => {
      fetchCalls.push({ url: String(url), opts });
      const body = { error: { code: "error", message } };
      return {
        ok: false,
        status,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => body,
        text: async () => JSON.stringify(body),
      } as unknown as Response;
    });
  }

  beforeEach(() => {
    fetchCalls = [];
    consoleLogs = [];
    consoleErrors = [];
    exitCode = undefined;
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) =>
      consoleLogs.push(String(args[0]))
    );
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      const line = String(args[0]);
      if (isBanner(line)) consoleLogs.push(line);
      consoleErrors.push(line);
    });
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      exitCode = code;
      throw new Error(`process.exit(${code})`);
    }) as never);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    setGlobalWorkspaceId(undefined);
  });

  // ── L3: setGlobalWorkspaceId threading ──────────────────────────────────

  it("createClient sends X-Workspace-Id once setGlobalWorkspaceId is set", async () => {
    let seenHeader: string | null = null;
    vi.stubGlobal("fetch", async (_url: string | URL, opts?: RequestInit) => {
      const headers = new Headers(opts?.headers);
      seenHeader = headers.get("x-workspace-id");
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({}),
        text: async () => "{}",
      } as unknown as Response;
    });

    setGlobalWorkspaceId("ws-from-flag");
    await createClient(mockConfig.url, mockConfig.apiKey).getMe();
    expect(seenHeader).toBe("ws-from-flag");

    setGlobalWorkspaceId(undefined);
    await createClient(mockConfig.url, mockConfig.apiKey).getMe();
    expect(seenHeader).toBeNull();
  });

  it("all new commands are registered", () => {
    const names = Object.keys(COMMANDS);
    for (const cmd of ["workspace", "tenant", "user", "token"]) {
      expect(names).toContain(cmd);
    }
  });

  // ── workspace ────────────────────────────────────────────────────────────

  it("workspace list calls GET /workspaces/mine", async () => {
    stubJson({
      workspaces: [
        { workspaceId: "ws1", workspaceName: "W", role: "admin", visibility: "private" },
      ],
    });
    await COMMANDS.workspace!(["list"], mockConfig);
    expectRequest(fetchCalls[0]!, { pathname: "/workspaces/mine" });
    expect(consoleLogs.join("\n")).toContain("ws1");
  });

  it("workspace list on a real 403 prints Error and exits 3 — does NOT print 'No workspaces found.'", async () => {
    stubError(403, "insufficient scope");
    await expect(COMMANDS.workspace!(["list"], mockConfig)).rejects.toThrow("process.exit(3)");
    expect(exitCode).toBe(3);
    expect(consoleErrors.join("\n")).toContain("403");
    expect(consoleLogs.join("\n")).not.toContain("No workspaces found.");
  });

  it("workspace show calls GET /workspaces/:id", async () => {
    stubJson({
      id: "ws1",
      name: "W",
      slug: null,
      tenantId: "t1",
      visibility: "private",
      createdAt: null,
    });
    await COMMANDS.workspace!(["show", "ws1"], mockConfig);
    expectRequest(fetchCalls[0]!, { pathname: "/workspaces/ws1" });
  });

  it("workspace members calls GET /workspaces/:id/members", async () => {
    stubJson({ members: [{ userId: "u1", role: "write", joinedAt: null }] });
    await COMMANDS.workspace!(["members", "ws1"], mockConfig);
    expectRequest(fetchCalls[0]!, { pathname: "/workspaces/ws1/members" });
  });

  it("workspace members on a real 403 prints Error and exits 3", async () => {
    stubError(403, "not a member");
    await expect(COMMANDS.workspace!(["members", "ws1"], mockConfig)).rejects.toThrow(
      "process.exit(3)"
    );
    expect(exitCode).toBe(3);
    expect(consoleLogs.join("\n")).not.toContain("No members found.");
  });

  it("workspace create posts to /tenants/:tenantId/workspaces", async () => {
    stubJson({
      id: "ws_new",
      name: "New",
      slug: null,
      tenantId: "t1",
      visibility: "private",
      createdAt: null,
    });
    await COMMANDS.workspace!(["create", "--name", "New", "--tenant", "t1"], mockConfig);
    expectRequest(fetchCalls[0]!, { method: "POST", pathname: "/tenants/t1/workspaces" });
    expect(JSON.parse(String(fetchCalls[0]?.opts?.body))).toEqual({ name: "New" });
  });

  it("workspace create resolves tenantId from GET /me when --tenant is omitted", async () => {
    vi.stubGlobal("fetch", async (url: string | URL, opts?: RequestInit) => {
      fetchCalls.push({ url: String(url), opts });
      if (String(url).endsWith("/me")) {
        return {
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({ tenantId: "t_from_me" }),
          text: async () => JSON.stringify({ tenantId: "t_from_me" }),
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 201,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({
          id: "ws2",
          name: "New",
          slug: null,
          tenantId: "t_from_me",
          visibility: "private",
          createdAt: null,
        }),
        text: async () => "{}",
      } as unknown as Response;
    });
    await COMMANDS.workspace!(["create", "--name", "New"], mockConfig);
    // fetchCalls[0] is the GET /me tenantId resolution; fetchCalls[1] is the
    // actual workspace-creation POST this test is really verifying.
    expectRequest(fetchCalls[1]!, { method: "POST", pathname: "/tenants/t_from_me/workspaces" });
  });

  it("workspace invite posts to /workspaces/:id/members with role", async () => {
    stubJson({ ok: true });
    await COMMANDS.workspace!(["invite", "ws1", "u2", "--role", "write"], mockConfig);
    expectRequest(fetchCalls[0]!, { pathname: "/workspaces/ws1/members" });
    expect(JSON.parse(String(fetchCalls[0]?.opts?.body))).toEqual({ userId: "u2", role: "write" });
  });

  it("workspace set-role patches /workspaces/:id/members/:userId", async () => {
    stubJson({ ok: true });
    await COMMANDS.workspace!(["set-role", "ws1", "u2", "admin"], mockConfig);
    expectRequest(fetchCalls[0]!, { method: "PATCH", pathname: "/workspaces/ws1/members/u2" });
    expect(JSON.parse(String(fetchCalls[0]?.opts?.body))).toEqual({ role: "admin" });
  });

  it("workspace remove deletes /workspaces/:id/members/:userId", async () => {
    stubJson({ ok: true });
    await COMMANDS.workspace!(["remove", "ws1", "u2"], mockConfig);
    expectRequest(fetchCalls[0]!, { method: "DELETE", pathname: "/workspaces/ws1/members/u2" });
  });

  // ── tenant ───────────────────────────────────────────────────────────────

  it("tenant create posts to /tenants", async () => {
    stubJson({ id: "t1", name: "Acme", kind: "organization", plan: "free", createdAt: null });
    await COMMANDS.tenant!(["create", "--name", "Acme"], mockConfig);
    expectRequest(fetchCalls[0]!, { method: "POST", pathname: "/tenants" });
  });

  it("tenant create --owner-token asks for and prints the new tenant's owner token", async () => {
    stubJson({
      id: "t1",
      name: "Acme",
      kind: "organization",
      plan: "free",
      createdAt: null,
      workspace: {
        id: "w1",
        name: "Main",
        slug: null,
        tenantId: "t1",
        visibility: "private",
        createdAt: null,
      },
      ownerToken: {
        id: "tok1",
        key: "uk_live_secret",
        label: "owner",
        scopes: ["memory:read"],
        userId: "u1",
        tenantId: "t1",
        workspaceId: "w1",
        maxSensitivity: null,
        createdAt: "2026-11-17T00:00:00.000Z",
      },
    });
    await COMMANDS.tenant!(
      ["create", "--name", "Acme", "--owner-token", "--workspace-name", "Main"],
      mockConfig
    );
    expect(JSON.parse(String(fetchCalls[0]!.opts?.body))).toMatchObject({
      name: "Acme",
      issueOwnerToken: true,
      workspaceName: "Main",
    });
    expect(consoleLogs.join("\n")).toContain("uk_live_secret");
    expect(consoleErrors.join("\n")).toContain("tenant t1, workspace w1");
  });

  it("tenant create without --owner-token says the current key cannot manage the new tenant", async () => {
    stubJson({ id: "t1", name: "Acme", kind: "organization", plan: "free", createdAt: null });
    await COMMANDS.tenant!(["create", "--name", "Acme"], mockConfig);
    expect(JSON.parse(String(fetchCalls[0]!.opts?.body))).not.toHaveProperty("issueOwnerToken");
    expect(consoleErrors.join("\n")).toContain("--owner-token");
  });

  // PR2 (cli-uimode-full-coverage): tenant management is an admin-kind
  // command — delight status line uses the closed admin emoji (🔑).
  it("tenant create delight status line uses the admin emoji (🔑)", async () => {
    stubJson({ id: "t1", name: "Acme", kind: "organization", plan: "free", createdAt: null });
    await COMMANDS.tenant!(["create", "--name", "Acme"], { ...mockConfig, uiMode: "delight" });
    expect(consoleLogs.some((l) => l.includes("🔑"))).toBe(true);
  });

  it("tenant show calls GET /tenants/:id", async () => {
    stubJson({ id: "t1", name: "Acme", kind: "organization", plan: "free", createdAt: null });
    await COMMANDS.tenant!(["show", "t1"], mockConfig);
    expectRequest(fetchCalls[0]!, { pathname: "/tenants/t1" });
  });

  it("tenant members calls GET /tenants/:id/members", async () => {
    stubJson({ members: [{ userId: "u1", role: "owner", joinedAt: null }] });
    await COMMANDS.tenant!(["members", "t1"], mockConfig);
    expectRequest(fetchCalls[0]!, { pathname: "/tenants/t1/members" });
  });

  it("tenant invite posts to /tenants/:id/members with createIfMissing", async () => {
    stubJson({ ok: true });
    await COMMANDS.tenant!(
      ["invite", "t1", "new@x.com", "--role", "member", "--create-if-missing"],
      mockConfig
    );
    expectRequest(fetchCalls[0]!, { pathname: "/tenants/t1/members" });
    expect(JSON.parse(String(fetchCalls[0]?.opts?.body))).toEqual({
      email: "new@x.com",
      role: "member",
      createIfMissing: true,
    });
  });

  it("tenant remove deletes /tenants/:id/members/:userId", async () => {
    stubJson({ ok: true });
    await COMMANDS.tenant!(["remove", "t1", "u2"], mockConfig);
    expectRequest(fetchCalls[0]!, { method: "DELETE", pathname: "/tenants/t1/members/u2" });
  });

  it("tenant workspaces calls GET /tenants/:id/workspaces", async () => {
    stubJson({
      workspaces: [{ id: "ws1", name: "W", slug: null, visibility: "private", memberCount: 2 }],
    });
    await COMMANDS.tenant!(["workspaces", "t1"], mockConfig);
    expectRequest(fetchCalls[0]!, { pathname: "/tenants/t1/workspaces" });
  });

  // ── user ─────────────────────────────────────────────────────────────────

  it("user create posts to /users", async () => {
    stubJson({
      user: {
        id: "u1",
        email: "a@b.com",
        displayName: null,
        personalTenantId: "t1",
        createdAt: null,
      },
      personalTenant: {
        id: "t1",
        name: "a@b.com",
        kind: "personal",
        plan: "free",
        createdAt: null,
      },
      personalWorkspace: {
        id: "ws1",
        name: "a@b.com's workspace",
        slug: null,
        tenantId: "t1",
        visibility: "private",
        createdAt: null,
      },
    });
    await COMMANDS.user!(["create", "--email", "a@b.com"], mockConfig);
    expectRequest(fetchCalls[0]!, { method: "POST", pathname: "/users" });
    expect(consoleLogs.join("\n")).toContain("u1");
  });

  // ── token ────────────────────────────────────────────────────────────────

  it("token issue posts to /tenants/:tenantId/users/:userId/tokens", async () => {
    stubJson({
      id: "uk_abc",
      key: "uk_live_deadbeef",
      label: "B's token",
      scopes: ["memory:read"],
      userId: "u2",
      tenantId: "t1",
      workspaceId: "ws1",
      expiresAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await COMMANDS.token!(
      ["issue", "t1", "u2", "--label", "B's token", "--workspace", "ws1"],
      mockConfig
    );
    expectRequest(fetchCalls[0]!, { method: "POST", pathname: "/tenants/t1/users/u2/tokens" });
    expect(consoleLogs.join("\n")).toContain("uk_live_deadbeef");
  });

  it("token list calls GET /tenants/:tenantId/users/:userId/tokens", async () => {
    stubJson({
      tokens: [
        {
          id: "uk_abc",
          label: "B's token",
          scopes: ["memory:read"],
          workspaceId: "ws1",
          expiresAt: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          lastUsedAt: null,
          revokedAt: null,
        },
      ],
    });
    await COMMANDS.token!(["list", "t1", "u2"], mockConfig);
    expectRequest(fetchCalls[0]!, { pathname: "/tenants/t1/users/u2/tokens" });
  });

  it("token revoke deletes /tenants/:tenantId/users/:userId/tokens/:keyId", async () => {
    stubJson({ ok: true, revokedAt: "2026-01-01T00:00:00.000Z" });
    await COMMANDS.token!(["revoke", "t1", "u2", "uk_abc"], mockConfig);
    expectRequest(fetchCalls[0]!, {
      method: "DELETE",
      pathname: "/tenants/t1/users/u2/tokens/uk_abc",
    });
  });
});
