import { describe, it, expect, vi } from "vitest";
import { createRbacMiddleware, type RbacDeps } from "../../middleware/rbac-policy.js";
import { InMemoryBreakGlassStore } from "@mnemo-ai/types/testing";

const WS = "ws-wire";
const A = "admin-A";

function ctx(method: string, path: string, prefix: string) {
  return {
    req: { method, path, header: () => undefined, query: () => undefined },
    get: (k: string) =>
      k === "workspaceId"
        ? WS
        : k === "actorId"
          ? A
          : k === "userId"
            ? A
            : k === "apiKeyPrefix"
              ? prefix
              : undefined,
    set: vi.fn(),
    header: vi.fn(),
    json: vi.fn((b: unknown, s: number) => new Response(JSON.stringify(b), { status: s })),
  } as never;
}

describe("break-glass end-to-end through createRbacMiddleware", () => {
  it("blocks before approval, allows after a second admin approves", async () => {
    const bg = new InMemoryBreakGlassStore();
    const deps: RbacDeps = {
      accessPolicies: {
        getPolicy: vi.fn().mockResolvedValue(null),
      } as unknown as RbacDeps["accessPolicies"],
      approvals: {
        get: vi.fn().mockResolvedValue(null),
        create: vi.fn(),
      } as unknown as RbacDeps["approvals"],
      breakGlass: bg,
    };
    const mw = createRbacMiddleware(deps);

    const r = await bg.request({
      workspaceId: WS,
      requestedBy: A,
      reason: "x",
      requestedScopes: ["memory:write"],
      expiresAt: new Date(Date.now() + 60_000), // determinism-ok: 60s future, approval not expired during test
    });
    await expect(mw(ctx("POST", "/facts", "mk_admin_"), vi.fn())).rejects.toMatchObject({
      status: 403,
    });

    await bg.approve(WS, r.id, "admin-B");
    const next = vi.fn().mockResolvedValue(undefined);
    await mw(ctx("POST", "/facts", "mk_admin_"), next);
    expect(next).toHaveBeenCalled();
  });
});
