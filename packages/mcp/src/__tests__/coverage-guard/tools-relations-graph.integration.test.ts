/**
 * B4.2 — MCP tool coverage fill-in: relations/graph tools (design.md "B4.
 * Coverage fill-in", spec.md Requirement 13). Exercises `memory_relate`
 * (`create`/`list`/`history`), `memory_entity` (`create`/`get`/`list`/
 * `update`/`linked_facts`/`link_user`/`unlink_user`), and `memory_hyperedge`
 * (`create`/`get`/`list`/`patch`/`archive`) against the real live-surface
 * harness's `mcp` stdio client.
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

describe("memory_relate (B4.2)", () => {
  it("action='create' — links a fact to an entity via ENTITY-1's part_of side effect", async () => {
    const fact = await json(
      await surface.http("POST", "/remember", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ statement: "B4.2 relate: fact linked to an entity." }),
      })
    );
    const entity = await json(
      await surface.http("POST", "/entities", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "B4.2 Relate Entity", kind: "concept" }),
      })
    );

    const created = await callToolOk(surface.mcp, "memory_relate", {
      action: "create",
      sourceKind: "fact",
      from: fact.id,
      targetKind: "entity",
      to: entity.id,
      verb: "part_of",
    });
    const body = created.structuredContent as { id: string; relation: string };
    expect(body.id).toBeTruthy();
    expect(body.relation).toBe("part_of");

    const linked = await callToolOk(surface.mcp, "memory_entity", {
      action: "linked_facts",
      id: entity.id,
    });
    const linkedBody = linked.structuredContent as { facts: Array<{ id: string }> };
    expect(linkedBody.facts.some((f) => f.id === fact.id)).toBe(true);
  });

  it("action='list' — lists relations in the workspace graph", async () => {
    const result = await callToolOk(surface.mcp, "memory_relate", { action: "list", limit: 10 });
    const body = result.structuredContent as { items: unknown[] };
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBeGreaterThan(0);
  });

  it("action='history' — walks a derived_from lineage chain from the newer fact", async () => {
    const factA = await json(
      await surface.http("POST", "/remember", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ statement: "B4.2 history: original fact A." }),
      })
    );
    const factB = await json(
      await surface.http("POST", "/remember", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ statement: "B4.2 history: fact B, derived from A." }),
      })
    );
    await callToolOk(surface.mcp, "memory_relate", {
      action: "create",
      sourceKind: "fact",
      from: factB.id,
      targetKind: "fact",
      to: factA.id,
      verb: "derived_from",
    });

    const history = await callToolOk(surface.mcp, "memory_relate", {
      action: "history",
      sourceKind: "fact",
      from: factB.id,
    });
    const body = history.structuredContent as {
      nodes: Array<{ id: string }>;
      edges: Array<{ relation: string }>;
    };
    expect(body.nodes.some((n) => n.id === factA.id)).toBe(true);
    expect(body.edges.some((e) => e.relation === "derived_from")).toBe(true);
  });
});

describe("memory_entity (B4.2)", () => {
  it("action='create', 'get', 'list', 'update'", async () => {
    const created = await callToolOk(surface.mcp, "memory_entity", {
      action: "create",
      name: "B4.2 Acme Corp",
      kind: "organization",
      description: "Seeded by B4.2 MCP coverage.",
    });
    const createdBody = created.structuredContent as { id: string; name: string };
    expect(createdBody.id).toBeTruthy();
    expect(createdBody.name).toBe("B4.2 Acme Corp");

    const got = await callToolOk(surface.mcp, "memory_entity", {
      action: "get",
      id: createdBody.id,
    });
    const gotBody = got.structuredContent as { entity: { id: string }; linkedFactCount: number };
    expect(gotBody.entity.id).toBe(createdBody.id);

    const listed = await callToolOk(surface.mcp, "memory_entity", {
      action: "list",
      q: "Acme",
    });
    const listedBody = listed.structuredContent as { items: Array<{ id: string }> };
    expect(listedBody.items.some((e) => e.id === createdBody.id)).toBe(true);

    const updated = await callToolOk(surface.mcp, "memory_entity", {
      action: "update",
      id: createdBody.id,
      description: "Updated by B4.2.",
    });
    const updatedBody = updated.structuredContent as { description: string };
    expect(updatedBody.description).toBe("Updated by B4.2.");
  });

  it("action='link_user' / 'unlink_user' — workspace-only key fails closed (real 403/404, matches B4.1's HTTP finding)", async () => {
    const person = await callToolOk(surface.mcp, "memory_entity", {
      action: "create",
      name: "B4.2 Person",
      kind: "person",
    });
    const personBody = person.structuredContent as { id: string };

    const linkResult = await callTool(surface.mcp, "memory_entity", {
      action: "link_user",
      id: personBody.id,
      userId: surface.secondaryIdentities.userA.id,
    });
    expect(linkResult.isError).toBe(true);

    const unlinkResult = await callTool(surface.mcp, "memory_entity", {
      action: "unlink_user",
      id: personBody.id,
    });
    expect(unlinkResult.isError).toBe(true);
  });
});

describe("memory_hyperedge (B4.2)", () => {
  it("action='create', 'get', 'list', 'patch', 'archive'", async () => {
    const members = await Promise.all(
      [1, 2, 3].map(async (n) => {
        const f = await json(
          await surface.http("POST", "/remember", {
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ statement: `B4.2 hyperedge member ${n}.` }),
          })
        );
        return f.id as string;
      })
    );

    const created = await callToolOk(surface.mcp, "memory_hyperedge", {
      action: "create",
      memberIds: members,
      label: "B4.2 hyperedge",
    });
    const createdBody = created.structuredContent as { id: string; memberIds: string[] };
    expect(createdBody.id).toBeTruthy();
    expect(createdBody.memberIds.sort()).toEqual([...members].sort());

    const got = await callToolOk(surface.mcp, "memory_hyperedge", {
      action: "get",
      id: createdBody.id,
    });
    expect((got.structuredContent as { id: string }).id).toBe(createdBody.id);

    const listed = await callToolOk(surface.mcp, "memory_hyperedge", {
      action: "list",
      labelFilter: "B4.2 hyperedge",
    });
    const listedBody = listed.structuredContent as { items: Array<{ id: string }> };
    expect(listedBody.items.some((h) => h.id === createdBody.id)).toBe(true);

    const patched = await callToolOk(surface.mcp, "memory_hyperedge", {
      action: "patch",
      id: createdBody.id,
      description: "Patched by B4.2.",
    });
    expect((patched.structuredContent as { description: string }).description).toBe(
      "Patched by B4.2."
    );

    const archived = await callToolOk(surface.mcp, "memory_hyperedge", {
      action: "archive",
      id: createdBody.id,
    });
    expect((archived.structuredContent as { archived: boolean }).archived).toBe(true);
  });
});
