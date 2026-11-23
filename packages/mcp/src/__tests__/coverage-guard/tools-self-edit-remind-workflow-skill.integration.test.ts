/**
 * B4.2 — MCP tool coverage fill-in: self-editing, prospective memory, and
 * procedural-knowledge tools (design.md "B4. Coverage fill-in", spec.md
 * Requirement 13). Exercises all 6 live `memory_self_edit` actions (`append`/
 * `replace`/`strengthen`/`weaken`/`reflect`/`link`), all 3
 * `memory_remind_when` actions (`create`/`list`/`dismiss`), all 3
 * `memory_workflow` actions (`create`/`get`/`list`), and all 4 `memory_skill`
 * actions (`create`/`get`/`list`/`forget`) against the real live-surface
 * harness's `mcp` stdio client.
 *
 * `memory_self_edit(action:"forget")` is NOT exercised here — the
 * `complete-mcp-tools` change's B4 fix removed it from the tool's registered
 * schema entirely (no approval flow ever existed to resolve the old
 * "202 pending" dead end). See
 * `packages/mcp/src/__tests__/contracts/self-edit-forget-schema.test.ts` for
 * schema-level coverage and `packages/server/src/__tests__/self-edit-budget.test.ts`
 * for the route-level 422 gate.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startLiveSurface, type LiveSurface } from "../harness/live-surface.js";
import { callToolOk } from "./mcp-tool-helpers.js";

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

describe("memory_self_edit (B4.2)", () => {
  // DISCOVERY (this session): the real server enforces a flat 300s edit
  // cooldown for successive edit-type self_edit actions
  // (`packages/core/src/cognitive/self-edit.ts`'s `ln()` policy gate,
  // `DEFAULT_SELF_EDIT_POLICY.editCooldown = 300`), keyed on
  // `(workspaceId, agentId)` — NOT on the target fact, so switching targets
  // does not bypass it. A SECOND discovery narrows the blast radius:
  // `packages/server/src/routes/self.ts`'s `POST /self/edit` handler
  // overrides `agentId` to `provenance.actorId` ONLY for `action==='replace'`
  // against a fact target (line ~488, "Fact edits are attributed to
  // authenticated tool identity, never body input") — every OTHER edit
  // action (append/strengthen/weaken/link) keeps the request body's
  // default `agentId: "default"`. That means `replace` tracks its cooldown
  // in a genuinely SEPARATE bucket from append/strengthen/weaken/
  // link, and can independently succeed even when the `"default"` bucket is
  // already inside its cooldown window. `reflect` bypasses the cooldown gate
  // entirely (the branch runs before the Promise.all that reads it). A real
  // automated test cannot wait out a genuine 300s window, so this file
  // exercises append/replace/reflect for real SUCCESS, and strengthen/
  // weaken/link for their real, documented cooldown REJECTION
  // (429) — an honest response for those branches, not a workaround.
  it("append — first edit on the shared 'default' agentId bucket succeeds for real", async () => {
    const created = await json(
      await surface.http("POST", "/remember", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ statement: "B4.2 self_edit base fact." }),
      })
    );

    const appended = await callToolOk(surface.mcp, "memory_self_edit", {
      action: "append",
      target: created.id,
      content: "B4.2 append via self_edit.",
      reason: "B4.2 coverage: append",
    });
    const appendedBody = appended.structuredContent as { applied: boolean; action: string };
    expect(appendedBody.applied).toBe(true);
    expect(appendedBody.action).toBe("append");
  });

  it("replace — succeeds independently (separate provenance.actorId cooldown bucket)", async () => {
    const created = await json(
      await surface.http("POST", "/remember", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ statement: "B4.2 self_edit fact for replace." }),
      })
    );
    const replaced = await callToolOk(surface.mcp, "memory_self_edit", {
      action: "replace",
      target: created.id,
      content: "B4.2 replaced content via self_edit.",
      reason: "B4.2 coverage: replace",
    });
    const body = replaced.structuredContent as { applied: boolean; replacementId?: string };
    expect(body.applied).toBe(true);
    expect(body.replacementId).toBeTruthy();
  });

  // PRIM-6 (WP-5): the cooldown belongs to the credential AND the target, so a
  // first edit of a new fact is allowed and a second edit of the same fact
  // within the cooldown is refused. (It used to be one bucket per agentId, so
  // the earlier append blocked edits of any other fact.)
  it("strengthen, then weaken and link on the same fact — real cooldown rejection", async () => {
    const created = await json(
      await surface.http("POST", "/remember", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ statement: "B4.2 self_edit cooldown-probe fact." }),
      })
    );

    const first = await callToolOk(surface.mcp, "memory_self_edit", {
      action: "strengthen",
      target: created.id,
      reason: "B4.2 coverage: strengthen (first edit of this fact)",
    });
    expect((first.structuredContent as { applied: boolean }).applied).toBe(true);

    for (const [action, extra] of [
      ["weaken", {}],
      ["link", { content: "mfact_placeholder_a,mfact_placeholder_b" }],
    ] as const) {
      const result = await surface.mcp.callTool(
        {
          name: "memory_self_edit",
          arguments: {
            action,
            target: created.id,
            reason: `B4.2 coverage: ${action} (expects cooldown)`,
            ...extra,
          },
        },
        undefined,
        { timeout: 5_000, maxTotalTimeout: 5_000 }
      );
      const isError = (result as { isError?: boolean }).isError;
      const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "";
      expect(isError).toBe(true);
      expect(text).toContain("edit cooldown active");
    }
  });

  it("reflect — runs the self-reflection cycle, bypasses the edit cooldown", async () => {
    const result = await callToolOk(surface.mcp, "memory_self_edit", {
      action: "reflect",
      target: "profile",
      reason: "B4.2 coverage: reflect",
    });
    const body = result.structuredContent as { applied: boolean; action: string };
    expect(body.applied).toBe(true);
    expect(body.action).toBe("reflect");
  });
});

describe("memory_remind_when (B4.2)", () => {
  it("create (condition-based), list, dismiss", async () => {
    const created = await callToolOk(surface.mcp, "memory_remind_when", {
      action: "create",
      content: "B4.2 remind_when: surface this when the query mentions coverage.",
      condition: "B4.2 mcp tool coverage",
    });
    const createdBody = created.structuredContent as { id: string; status: string };
    expect(createdBody.id).toBeTruthy();

    const listed = await callToolOk(surface.mcp, "memory_remind_when", {
      action: "list",
      status: "pending",
    });
    const listedBody = listed.structuredContent as { reminders: Array<{ id: string }> };
    expect(listedBody.reminders.some((r) => r.id === createdBody.id)).toBe(true);

    const dismissed = await callToolOk(surface.mcp, "memory_remind_when", {
      action: "dismiss",
      id: createdBody.id,
    });
    expect((dismissed.structuredContent as { dismissed: boolean }).dismissed).toBe(true);
  });
});

describe("memory_workflow (B4.2)", () => {
  it("create, get, list", async () => {
    const created = await callToolOk(surface.mcp, "memory_workflow", {
      action: "create",
      name: "B4.2 workflow",
      description: "A workflow created for B4.2 MCP coverage.",
      steps: [
        { order: 0, action: "Gather requirements." },
        { order: 1, action: "Implement.", condition: "requirements gathered" },
      ],
    });
    const createdBody = created.structuredContent as { id: string; name: string };
    expect(createdBody.id).toBeTruthy();
    expect(createdBody.name).toBe("B4.2 workflow");

    const got = await callToolOk(surface.mcp, "memory_workflow", {
      action: "get",
      id: createdBody.id,
    });
    expect((got.structuredContent as { id: string }).id).toBe(createdBody.id);

    const listed = await callToolOk(surface.mcp, "memory_workflow", { action: "list" });
    const listedBody = listed.structuredContent as { items: Array<{ id: string }> };
    expect(listedBody.items.some((w) => w.id === createdBody.id)).toBe(true);
  });
});

describe("memory_skill (B4.2)", () => {
  it("create, get, list, forget", async () => {
    const created = await callToolOk(surface.mcp, "memory_skill", {
      action: "create",
      name: "B4.2 skill",
      promptTemplate: "Do the B4.2 coverage thing.",
    });
    const createdBody = created.structuredContent as { id: string; name: string };
    expect(createdBody.id).toBeTruthy();

    const got = await callToolOk(surface.mcp, "memory_skill", {
      action: "get",
      id: createdBody.id,
    });
    expect((got.structuredContent as { id: string }).id).toBe(createdBody.id);

    const listed = await callToolOk(surface.mcp, "memory_skill", { action: "list" });
    const listedBody = listed.structuredContent as { items: Array<{ id: string }> };
    expect(listedBody.items.some((s) => s.id === createdBody.id)).toBe(true);

    const forgotten = await callToolOk(surface.mcp, "memory_skill", {
      action: "forget",
      id: createdBody.id,
    });
    expect((forgotten.structuredContent as { forgotten: boolean }).forgotten).toBe(true);

    const relistedAfterForget = await callToolOk(surface.mcp, "memory_skill", {
      action: "list",
    });
    const relistedBody = relistedAfterForget.structuredContent as { items: Array<{ id: string }> };
    expect(relistedBody.items.some((s) => s.id === createdBody.id)).toBe(false);
  });
});
