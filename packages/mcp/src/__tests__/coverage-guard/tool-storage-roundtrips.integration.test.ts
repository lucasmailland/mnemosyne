/**
 * tool-promise-remediation phases 3–16 — the scenarios a stub cannot answer.
 *
 * Each of the 14 tool audits under `docs/archive/openspec/tool-promise-remediation/tools/`
 * lists scenarios to prove or disprove. Most are MCP-layer claims (this action
 * reaches that method, this guard rejects before any call) and are covered by
 * the contract tests next door. A handful are NOT: they are claims about what
 * the STORAGE does, and a stubbed client answers them the way you wrote the
 * stub. Those live here.
 *
 * `memory_workflow` — "pasos ordenados". The contract test proves the tool
 * forwards steps in the caller's order; it cannot prove the order survives the
 * database, which is the actual promise. An unordered representation would
 * round-trip correctly in a stub and shuffle in Postgres.
 *
 * `memory_skill` — "forget archives, it does not hard-delete". The contract
 * test proves `forget` routes to the primitive archive path rather than
 * `forgetFact`. Whether the row still EXISTS afterwards is a question only the
 * database can answer, and it is the whole point of the claim: an archive that
 * deletes is a delete with better manners.
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

/** Unique and NON-NUMERIC — see P119: 10+ digits get stored as [REDACTED-phone]. */
function marker(): string {
  // Uniqueness ACROSS runs is the requirement here, not repeatability: these tests
  // write into a database that outlives the run, so a fixed marker would collide
  // with the previous run's rows.
  return `mk-${Math.random().toString(36).slice(2, 10)}`; // determinism-ok: see above
}

describe("memory_workflow — step order survives the database", () => {
  it("creates with [A, B, C] and gets back [A, B, C]", async () => {
    const name = `wf ${marker()}`;
    // Deliberately NOT alphabetical, and deliberately not in `order` order
    // when sorted by action text: if anything sorts by the wrong key, or
    // relies on insertion order it does not actually control, this catches it.
    const steps = [
      { order: 0, action: `zeta first ${marker()}` },
      { order: 1, action: `alpha second ${marker()}` },
      { order: 2, action: `mike third ${marker()}` },
    ];

    const created = await callToolOk(surface.mcp, "memory_workflow", {
      action: "create",
      name,
      steps,
    });
    const id =
      (created.structuredContent as { id?: string; workflow?: { id: string } }).id ??
      (created.structuredContent as { workflow: { id: string } }).workflow.id;
    expect(id).toBeTruthy();

    const fetched = await callToolOk(surface.mcp, "memory_workflow", { action: "get", id });
    const body = fetched.structuredContent as {
      steps?: Array<{ order: number; action: string }>;
      workflow?: { steps: Array<{ order: number; action: string }> };
    };
    const back = body.steps ?? body.workflow?.steps ?? [];

    expect(back).toHaveLength(3);
    expect(back.map((s) => s.action)).toEqual(steps.map((s) => s.action));
    expect(back.map((s) => s.order)).toEqual([0, 1, 2]);
  }, 60_000);
});

describe("memory_skill — forget archives, it does not hard-delete", () => {
  it("the row survives the forget, it just stops being active", async () => {
    const name = `skill ${marker()}`;
    const created = await callToolOk(surface.mcp, "memory_skill", {
      action: "create",
      name,
      promptTemplate: `do the thing ${marker()}`,
    });
    const id =
      (created.structuredContent as { id?: string; skill?: { id: string } }).id ??
      (created.structuredContent as { skill: { id: string } }).skill.id;
    expect(id).toBeTruthy();

    const forgotten = await callTool(surface.mcp, "memory_forget", {
      kind: "skill",
      primitiveId: id,
    });
    expect(forgotten.isError, JSON.stringify(forgotten)).toBeFalsy();

    // The claim under test. A hard delete and a correct archive are
    // indistinguishable from the caller's side — both make the skill stop
    // showing up — so the only way to tell them apart is to go looking for the
    // row afterwards. It is still there: NOT hard-deleted. Claim upheld.
    const fetched = await callTool(surface.mcp, "memory_skill", { action: "get", id });
    expect(fetched.isError, "forget hard-deleted the skill — the row is gone").toBeFalsy();

    // P120, FIXED. This assertion used to be inverted: it pinned the ABSENCE
    // of any lifecycle field, because the projection had none and the first
    // draft's `status !== "active"` was passing vacuously on `undefined`. The
    // pair now travels, so a forgotten skill is distinguishable from a live one
    // by looking at it — which is the whole point of a bitemporal archive.
    const body = fetched.structuredContent as { validFrom?: string; validTo?: string | null };
    expect(body.validFrom, "validFrom must travel — see P120").toBeTruthy();
    expect(body.validTo, "a forgotten skill must come back with its interval CLOSED").toBeTruthy();

    // The observable half of the archive: it leaves the default listing.
    // Without this, "not hard-deleted" would be indistinguishable from
    // "forget did nothing at all".
    const listed = await callToolOk(surface.mcp, "memory_skill", { action: "list" });
    const sc = listed.structuredContent as {
      items?: Array<{ id: string }>;
      skills?: Array<{ id: string }>;
    };
    const items = sc.items ?? sc.skills ?? [];
    expect(
      items.some((s) => s.id === id),
      "the forgotten skill is still in the default listing — forget had no observable effect"
    ).toBe(false);
  }, 60_000);
});
