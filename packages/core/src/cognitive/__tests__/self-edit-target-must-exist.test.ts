/**
 * P123 — a self-edit against a target that does not exist must FAIL, not
 * report success.
 *
 * Found against the running container: `memory_self_edit(action:"append")` with
 * a well-formed uuid that names no row answered
 *
 *   200 {"applied":true,"action":"append","countsAsEdit":true}
 *
 * and wrote nothing. Not a reporting mismatch like P121 — a write that claims
 * to have happened. The agent has no reason to re-read, and `countsAsEdit`
 * charges the edit budget and starts the 300s cooldown, so it also pays for the
 * write it did not get.
 *
 * The cause was structural, not a typo: `replace` grew an existence check and
 * the other branches did not. `append` read the row and ran
 * `if (existing && content)` with NO else, so a miss fell through to the
 * switch's success return. `strengthen`, `weaken` and `forget` never read the
 * row at all — they call `updateWorth`/`archiveFact` on whatever id they were
 * handed and report success either way.
 *
 * The fix hoists "does the target exist" ahead of the switch, so the answer is
 * a property of the operation rather than something each branch has to
 * remember. These tests are per-action on purpose: the point is that no branch
 * is exempt, and a table is what makes a newly added exempt branch visible.
 */
import { describe, it, expect, vi } from "vitest";

import { applySelfEdit, SelfEditTargetNotFoundError } from "../self-edit.js";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";
import type { CoreContext } from "../../types.js";

const WS = "ws_1";
const MISSING = "00000000-0000-4000-8000-0000000000ff";

function makeCtx(storage: InMemoryStorageAdapter): CoreContext {
  return {
    storage,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    telemetry: {
      startSpan: () => ({ end: vi.fn(), setAttribute: vi.fn(), recordException: vi.fn() }),
    },
    config: {},
  } as unknown as CoreContext;
}

async function edit(storage: InMemoryStorageAdapter, action: string, target: string) {
  return applySelfEdit(makeCtx(storage), {
    workspaceId: WS,
    agentId: "agent_1",
    action,
    target,
    content: "algo,otro,tercero",
    reason: "P123 test",
    sessionId: "s1",
  } as never);
}

describe("P123 — every targeted action rejects a target that is not there", () => {
  for (const action of ["append", "replace", "strengthen", "weaken", "forget"] as const) {
    it(`${action} throws instead of reporting applied`, async () => {
      const storage = new InMemoryStorageAdapter();

      await expect(
        edit(storage, action, MISSING),
        `${action} accepted a nonexistent target`
      ).rejects.toBeInstanceOf(SelfEditTargetNotFoundError);
    });
  }

  it("append on a REAL fact still works — the guard rejects misses, not writes", async () => {
    // The other half. A check that rejects everything would pass every
    // assertion above and break the tool.
    const storage = new InMemoryStorageAdapter();
    const fact = await storage.createFact({
      workspaceId: WS,
      subject: "workspace",
      kind: "other",
      statement: "texto base",
      actorId: "key:k1",
      actorType: "agent",
      userId: null,
    } as never);

    const res = await applySelfEdit(makeCtx(storage), {
      workspaceId: WS,
      agentId: "agent_1",
      action: "append",
      target: fact.id,
      content: "agregado",
      reason: "P123 test",
      sessionId: "s1",
    } as never);

    expect(res.applied).toBe(true);
    const after = await storage.getFact(fact.id, WS);
    // `applied: true` has to mean the row changed. That equivalence is the
    // entire point of this file.
    expect(after?.statement).toBe("texto base\nagregado");
  });

  it("a missing STRATEGY target is rejected too", async () => {
    const storage = new InMemoryStorageAdapter();

    await expect(edit(storage, "append", `strategy:${MISSING}`)).rejects.toBeInstanceOf(
      SelfEditTargetNotFoundError
    );
  });

  it("reflect is exempt, and fails for its OWN reason rather than target-not-found", async () => {
    // Excluded deliberately, not by oversight: reflect does not address a row.
    // applySelfEdit refuses it outright and points at runReflectionCycle().
    // Asserted as a DIFFERENT error rather than as success, because "it throws"
    // would also pass if the new existence check had swallowed it — and that
    // would hide the exemption behind a coincidence.
    const storage = new InMemoryStorageAdapter();

    await expect(edit(storage, "reflect", MISSING)).rejects.toThrow(/runReflectionCycle/);
    await expect(edit(storage, "reflect", MISSING)).rejects.not.toBeInstanceOf(
      SelfEditTargetNotFoundError
    );
  });
});
