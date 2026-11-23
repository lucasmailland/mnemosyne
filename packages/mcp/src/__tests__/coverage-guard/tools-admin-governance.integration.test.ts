/**
 * B4.2 — MCP tool coverage fill-in: admin/governance tools (design.md "B4.
 * Coverage fill-in", spec.md Requirement 13). Exercises `memory_workspace`
 * (all 8 actions), `memory_doctor`, `memory_judge` (`list`/`resolve`),
 * `memory_purge` (`fact`/`closed` — destructive, exercised against
 * throwaway facts in the harness's own throwaway workspace), `memory_
 * consolidate`, `memory_stats`, and `memory_status` against the real
 * live-surface harness's `mcp` stdio client.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startLiveSurface, type LiveSurface } from "../harness/live-surface.js";
import { callTool, callToolOk } from "./mcp-tool-helpers.js";

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

describe("memory_workspace (B4.2)", () => {
  it("action='current' and action='list'", async () => {
    const current = await callToolOk(surface.mcp, "memory_workspace", { action: "current" });
    expect((current.structuredContent as { workspaceId: string }).workspaceId).toBe(
      surface.workspaceId
    );

    const listed = await callToolOk(surface.mcp, "memory_workspace", { action: "list" });
    const body = listed.structuredContent as { workspaces: unknown[] };
    expect(Array.isArray(body.workspaces)).toBe(true);
  });

  it("action='create', 'describe', 'invite', 'members', 'set_role', 'remove'", async () => {
    // The harness key has no tenant and no user, so it acts in its home
    // workspace's tenant (AUTH-TENANT-NULL) — not in a tenant it creates.
    const tenant = { id: surface.secondaryIdentities.tenantId };

    const created = await callToolOk(surface.mcp, "memory_workspace", {
      action: "create",
      name: "B4.2 mcp-tool workspace",
      tenantId: tenant.id,
    });
    const ws = (created.structuredContent as { workspace: { id: string; name: string } }).workspace;
    expect(ws.id).toBeTruthy();
    expect(ws.name).toBe("B4.2 mcp-tool workspace");

    // action='describe' via the harness's workspace-only primary key hits a
    // real, documented anti-probing rejection (B4.1 discovery): such a key's
    // GET /workspaces/:id only succeeds for its OWN bound workspaceId — a
    // genuine 404 for any other, not a test bug. Its own workspace reads.
    const described = await callTool(surface.mcp, "memory_workspace", {
      action: "describe",
      workspaceId: ws.id,
    });
    expect(described.isError).toBe(true);
    const describedOwn = await callToolOk(surface.mcp, "memory_workspace", {
      action: "describe",
      workspaceId: surface.workspaceId,
    });
    expect((describedOwn.structuredContent as { workspace: { id: string } }).workspace.id).toBe(
      surface.workspaceId
    );

    const newUser = await json(
      await surface.http("POST", "/users", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "b4.2-mcp-tool-member@example.com" }),
      })
    );
    await surface.http("POST", `/tenants/${tenant.id}/members`, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "b4.2-mcp-tool-member@example.com", role: "member" }),
    });

    const invited = await callToolOk(surface.mcp, "memory_workspace", {
      action: "invite",
      workspaceId: ws.id,
      userId: newUser.user.id,
      role: "read",
    });
    expect(typeof invited.structuredContent).toBe("object");

    const members = await callToolOk(surface.mcp, "memory_workspace", {
      action: "members",
      workspaceId: ws.id,
    });
    const membersBody = members.structuredContent as { members: Array<{ userId: string }> };
    expect(membersBody.members.some((m) => m.userId === newUser.user.id)).toBe(true);

    const roleSet = await callToolOk(surface.mcp, "memory_workspace", {
      action: "set_role",
      workspaceId: ws.id,
      userId: newUser.user.id,
      role: "write",
    });
    expect(typeof roleSet.structuredContent).toBe("object");

    const removed = await callToolOk(surface.mcp, "memory_workspace", {
      action: "remove",
      workspaceId: ws.id,
      userId: newUser.user.id,
    });
    expect(typeof removed.structuredContent).toBe("object");
  });
});

describe("memory_doctor (B4.2)", () => {
  it("runs all 8 operational diagnostic checks", async () => {
    const result = await callToolOk(surface.mcp, "memory_doctor", {});
    const body = result.structuredContent as {
      status: string;
      checks: Array<{ name: string; status: string }>;
    };
    expect(["ok", "warn", "error", "unknown"]).toContain(body.status);
    expect(body.checks.length).toBeGreaterThanOrEqual(8);
    expect(body.checks.some((c) => c.name === "env_config")).toBe(true);
    expect(body.checks.some((c) => c.name === "mcp_tools")).toBe(true);
  });
});

describe("memory_judge (B4.2)", () => {
  it("list finds a real conflicts_with pair, resolve keeps both", async () => {
    const factA = await json(
      await surface.http("POST", "/remember", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ statement: "B4.2 judge: fact A says X." }),
      })
    );
    const factB = await json(
      await surface.http("POST", "/remember", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ statement: "B4.2 judge: fact B says NOT X." }),
      })
    );
    await callToolOk(surface.mcp, "memory_relate", {
      action: "create",
      sourceKind: "fact",
      from: factA.id,
      targetKind: "fact",
      to: factB.id,
      verb: "conflicts_with",
    });

    const listed = await callToolOk(surface.mcp, "memory_judge", { action: "list", limit: 20 });
    const listedBody = listed.structuredContent as {
      pairs: Array<{ relationId: string; factA: { id: string }; factB: { id: string } }>;
    };
    const pair = listedBody.pairs.find(
      (p) =>
        (p.factA.id === factA.id && p.factB.id === factB.id) ||
        (p.factA.id === factB.id && p.factB.id === factA.id)
    );
    expect(pair).toBeTruthy();

    const resolved = await callToolOk(surface.mcp, "memory_judge", {
      action: "resolve",
      relationId: pair!.relationId,
      resolution: "keep_both",
    });
    const resolvedBody = resolved.structuredContent as { resolved: boolean; action: string };
    expect(resolvedBody.resolved).toBe(true);
    expect(resolvedBody.action).toBe("keep_both");
  });
});

describe("memory_consolidate (B4.2)", () => {
  it("triggers a real fast/dryRun:false consolidation pass", async () => {
    const result = await callToolOk(surface.mcp, "memory_consolidate", {});
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("Consolidation pass complete");
    expect(text).toContain("mode:       fast");
  });
});

describe("memory_stats (B4.2)", () => {
  it("returns aggregate workspace statistics", async () => {
    const result = await callToolOk(surface.mcp, "memory_stats", {});
    const body = result.structuredContent as { facts: { live: number } };
    expect(typeof body.facts.live).toBe("number");
  });
});

describe("memory_status (B4.2)", () => {
  it("returns vitals plus real instance-wide dependency health", async () => {
    const result = await callToolOk(surface.mcp, "memory_status", {});
    const body = result.structuredContent as { dependencyHealth?: { status: string } };
    expect(body.dependencyHealth?.status).toBeTruthy();
  });
});

describe("memory_purge (B4.2) — DESTRUCTIVE, exercised against throwaway facts only", () => {
  it("action='fact' hard-deletes a single fact permanently", async () => {
    const created = await json(
      await surface.http("POST", "/remember", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ statement: "B4.2 purge: fact to hard-delete." }),
      })
    );
    const purged = await callToolOk(surface.mcp, "memory_purge", {
      action: "fact",
      factId: created.id,
    });
    expect(typeof purged.structuredContent).toBe("object");

    // Hard-deleted — GET now 404s (not just archived).
    const getRes = await surface.http("GET", `/facts/${created.id}`);
    expect(getRes.status).toBe(404);
  });

  it("action='closed' bulk hard-deletes all forgotten (soft-deleted) facts", async () => {
    const created = await json(
      await surface.http("POST", "/remember", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ statement: "B4.2 purge: fact to forget then bulk-purge." }),
      })
    );
    await surface.http("DELETE", `/facts/${created.id}`);

    // APP-062 follow-up: bulk purge needs an explicit confirm.
    const result = await callTool(surface.mcp, "memory_purge", { action: "closed", confirm: true });
    // Real result either way — assert it's a structured, non-error response
    // (exact count depends on how many other tests in this run also closed
    // facts in the shared harness workspace).
    expect(result.isError).toBeFalsy();
    expect(typeof result.structuredContent).toBe("object");
  });
});
