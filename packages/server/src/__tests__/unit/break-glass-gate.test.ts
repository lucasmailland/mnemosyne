import { describe, it, expect, vi } from "vitest";
import { createRbacMiddleware, type RbacDeps } from "../../middleware/rbac-policy.js";
import { InMemoryBreakGlassStore } from "@mnemo-ai/types/testing";

const WS = "ws-bg";
const ADMIN_A = "admin-A";

function makeCtx(
  method: string,
  path: string,
  vars: Record<string, unknown>,
  headers: Record<string, string> = {}
) {
  return {
    req: {
      method,
      path,
      header: (n: string) => headers[n.toLowerCase()] ?? undefined,
      query: () => undefined,
    },
    get: (key: string) => vars[key],
    set: vi.fn(),
    header: vi.fn(),
    json: vi.fn((body: unknown, status: number) => new Response(JSON.stringify(body), { status })),
  };
}

function baseDeps(breakGlass: RbacDeps["breakGlass"]): RbacDeps {
  return {
    // No policy configured → §19 path is pass-through, isolating the break-glass gate.
    accessPolicies: {
      getPolicy: vi.fn().mockResolvedValue(null),
    } as unknown as RbacDeps["accessPolicies"],
    approvals: {
      get: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: "a1" }),
    } as unknown as RbacDeps["approvals"],
    ...(breakGlass ? { breakGlass } : {}),
  };
}

describe("rbac break-glass gate (mk_admin_)", () => {
  it("BLOCKS a privileged mk_admin_ op with no active grant (403)", async () => {
    const bg = new InMemoryBreakGlassStore();
    await bg.request({
      workspaceId: WS,
      requestedBy: ADMIN_A,
      reason: "x",
      requestedScopes: ["memory:write"],
      expiresAt: new Date(Date.now() + 60_000), // determinism-ok: 60s future, approval not expired during test
    });
    const mw = createRbacMiddleware(baseDeps(bg));
    const next = vi.fn();
    const ctx = makeCtx("POST", "/facts", {
      workspaceId: WS,
      actorId: ADMIN_A,
      userId: ADMIN_A,
      apiKeyPrefix: "mk_admin_",
    }) as never;
    await expect(mw(ctx, next)).rejects.toMatchObject({ status: 403 });
    expect(next).not.toHaveBeenCalled();
  });

  it("ALLOWS a privileged mk_admin_ op after admin B approves, then consumes the grant", async () => {
    const bg = new InMemoryBreakGlassStore();
    const r = await bg.request({
      workspaceId: WS,
      requestedBy: ADMIN_A,
      reason: "x",
      requestedScopes: ["memory:write"],
      expiresAt: new Date(Date.now() + 60_000), // determinism-ok: 60s future, approval not expired during test
    });
    await bg.approve(WS, r.id, "admin-B");
    const mw = createRbacMiddleware(baseDeps(bg));
    const next = vi.fn().mockResolvedValue(undefined);
    const ctx = makeCtx("POST", "/facts", {
      workspaceId: WS,
      actorId: ADMIN_A,
      userId: ADMIN_A,
      apiKeyPrefix: "mk_admin_",
    }) as never;
    await mw(ctx, next);
    expect(next).toHaveBeenCalled();
    // single-use: the grant is consumed.
    expect(await bg.getActiveApproved(WS, ADMIN_A)).toBeNull();
  });

  it("does NOT gate a READ op for mk_admin_ (read is not privileged)", async () => {
    const bg = new InMemoryBreakGlassStore();
    const mw = createRbacMiddleware(baseDeps(bg));
    const next = vi.fn().mockResolvedValue(undefined);
    const ctx = makeCtx("GET", "/recall", {
      workspaceId: WS,
      actorId: ADMIN_A,
      userId: ADMIN_A,
      apiKeyPrefix: "mk_admin_",
    }) as never;
    await mw(ctx, next);
    expect(next).toHaveBeenCalled();
  });

  it("does NOT gate non-admin keys", async () => {
    const bg = new InMemoryBreakGlassStore();
    const mw = createRbacMiddleware(baseDeps(bg));
    const next = vi.fn().mockResolvedValue(undefined);
    const ctx = makeCtx("POST", "/facts", {
      workspaceId: WS,
      actorId: "agent-1",
      apiKeyPrefix: "mk_live_",
    }) as never;
    await mw(ctx, next);
    expect(next).toHaveBeenCalled();
  });

  it("fails CLOSED (403) for a privileged mk_admin_ op when no breakGlass store is wired", async () => {
    const deps = baseDeps(undefined);
    const mw = createRbacMiddleware(deps);
    const next = vi.fn();
    const ctx = makeCtx("POST", "/facts", {
      workspaceId: WS,
      actorId: ADMIN_A,
      userId: ADMIN_A,
      apiKeyPrefix: "mk_admin_",
    }) as never;
    await expect(mw(ctx, next)).rejects.toMatchObject({ status: 403 });
    expect(next).not.toHaveBeenCalled();
  });
});
