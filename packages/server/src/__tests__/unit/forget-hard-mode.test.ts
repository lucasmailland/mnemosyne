/**
 * V-8 (SEC-4) — `DELETE /forget/:kind/:id?mode=hard` was silently a soft delete.
 *
 * Measured on integration/eval-fixes: `DELETE /forget/fact/:id?mode=hard&reason=gdpr-art17`
 * answered 200 `{forgotten: true}` and only closed the row — the query schema
 * dropped `mode`, and the handler hardcoded "soft". A caller asking for a hard
 * delete was told it succeeded while the statement stayed in the database.
 *
 * `mode=hard` on a fact now runs the same audited resource hard delete as
 * `DELETE /facts/:id/hard` (memory:hard_delete, deletion-log row, terminal
 * audit entry, S6 ceiling). On any other kind there is no resource hard delete,
 * so it is refused with 400 — never downgraded. Person-wide GDPR erasure is a
 * separate route that names its subject (POST /admin/erasure).
 */
import { describe, it, expect, vi } from "vitest";
import bcrypt from "bcrypt";
import type { ApiKeyLookup } from "../../auth.js";
import { BCRYPT_COST } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import { mountForget } from "../../routes/forget.js";
import { buildMountHarness } from "../_mountHarness.js";

const KEY = "mns_live_forgethardmodetest0000001";
const WS = "00000000-0000-0000-0000-0000000000e8";
const FACT_ID = "22222222-3333-4444-8555-666666666666";

function factRecord(sensitivity = "internal") {
  const now = new Date("2026-10-18T00:00:00.000Z");
  return {
    id: FACT_ID,
    workspaceId: WS,
    statement: "kestrel ships on thursdays",
    subject: "kestrel",
    kind: "other",
    scope: "global",
    status: "active",
    pinned: false,
    sensitivity,
    confidence: 0.9,
    attribution: "inferred",
    tags: [],
    metadata: {},
    validFrom: now,
    validTo: null,
    createdAt: now,
    updatedAt: now,
  };
}

async function buildApp(opts: {
  scopes?: string[];
  sensitivity?: string;
  /** Ids the storage reports as above the caller's ceiling (APP-008). */
  hiddenIds?: string[];
  maxSensitivity?: string;
  hardDeleteFact?: ReturnType<typeof vi.fn> | null;
}) {
  const keyHash = await bcrypt.hash(KEY, BCRYPT_COST);
  const apiKeys = {
    listActive: async () => [
      {
        id: "key-eraser",
        keyHash,
        workspaceId: WS,
        scopes: opts.scopes ?? ["memory:read", "memory:delete", "memory:hard_delete"],
        ...(opts.maxSensitivity ? { maxSensitivity: opts.maxSensitivity } : {}),
      },
    ],
    findByLookupHash: undefined,
    setLookupHash: undefined,
    touch: async () => {},
  } as unknown as ApiKeyLookup;
  const hardDeleteFact =
    opts.hardDeleteFact === null
      ? undefined
      : (opts.hardDeleteFact ?? vi.fn().mockResolvedValue(true));
  const appendAuditEntry = vi.fn().mockResolvedValue(undefined);
  const forget = vi.fn().mockResolvedValue(undefined);
  const deps = {
    apiKeys,
    storage: {
      getFact: vi.fn().mockResolvedValue(factRecord(opts.sensitivity)),
      findHiddenIds: vi.fn().mockResolvedValue(opts.hiddenIds ?? []),
      ...(hardDeleteFact ? { hardDeleteFact } : {}),
      appendAuditEntry,
    },
    cognitive: { forget },
  } as unknown as ServerDeps;
  return { app: buildMountHarness(deps, [mountForget]), hardDeleteFact, appendAuditEntry, forget };
}

function del(app: Awaited<ReturnType<typeof buildApp>>["app"], path: string) {
  return app.request(path, { method: "DELETE", headers: { authorization: `Bearer ${KEY}` } });
}

describe("V-8 — DELETE /forget/fact/:id?mode=hard is a real, audited hard delete", () => {
  it("REGRESSION: mode=hard deletes the row through the audited hard-delete path, not the soft forget", async () => {
    const { app, hardDeleteFact, appendAuditEntry, forget } = await buildApp({});
    const res = await del(app, `/forget/fact/${FACT_ID}?mode=hard&reason=gdpr-art17`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ forgotten: true, mode: "hard", deleted: true });
    expect(forget).not.toHaveBeenCalled();
    expect(hardDeleteFact).toHaveBeenCalledWith(
      FACT_ID,
      WS,
      expect.objectContaining({
        actorId: "key:key-eraser",
        reason: expect.stringContaining("gdpr-art17"),
      })
    );
    expect(appendAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WS,
        actorId: "key:key-eraser",
        action: "hard_delete",
        resourceKind: "fact",
        resourceId: FACT_ID,
        isTerminal: true,
        detail: expect.objectContaining({ gdprErasure: false }),
      })
    );
  });

  it("REGRESSION: without memory:hard_delete it is a 403 — never a silent soft delete", async () => {
    const { app, hardDeleteFact, forget } = await buildApp({
      scopes: ["memory:read", "memory:delete"],
    });
    const res = await del(app, `/forget/fact/${FACT_ID}?mode=hard`);
    expect(res.status).toBe(403);
    expect(hardDeleteFact).not.toHaveBeenCalled();
    expect(forget).not.toHaveBeenCalled();
  });

  it("a fact above the caller's ceiling is a 404 (S6) and survives", async () => {
    const { app, hardDeleteFact, appendAuditEntry } = await buildApp({
      sensitivity: "confidential",
    });
    expect((await del(app, `/forget/fact/${FACT_ID}?mode=hard`)).status).toBe(404);
    expect(hardDeleteFact).not.toHaveBeenCalled();
    expect(appendAuditEntry).not.toHaveBeenCalled();
  });

  it("shares the hard-delete path's refusals: 409 mid-consolidation, 501 without the capability", async () => {
    const busy = await buildApp({ hardDeleteFact: vi.fn().mockResolvedValue(false) });
    expect((await del(busy.app, `/forget/fact/${FACT_ID}?mode=hard`)).status).toBe(409);
    expect(busy.forget).not.toHaveBeenCalled();
    const none = await buildApp({ hardDeleteFact: null });
    expect((await del(none.app, `/forget/fact/${FACT_ID}?mode=hard`)).status).toBe(501);
    expect(none.forget).not.toHaveBeenCalled();
  });
});

describe("V-8 — mode=hard is refused, not downgraded, where no hard delete exists", () => {
  it("REGRESSION: mode=hard on a decision is a 400 that points at what is supported", async () => {
    const { app, hardDeleteFact, forget } = await buildApp({});
    const res = await del(app, "/forget/decision/dec-1?mode=hard");
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; message: string; details: Record<string, unknown> };
    };
    expect(body.error.code).toBe("hard_delete_unsupported");
    expect(body.error.details).toMatchObject({ kind: "decision", supportedKinds: ["fact"] });
    expect(body.error.message).toContain("/forget/fact/");
    expect(forget).not.toHaveBeenCalled();
    expect(hardDeleteFact).not.toHaveBeenCalled();
  });

  it("an unknown mode is a 400, not a soft delete", async () => {
    const { app, forget } = await buildApp({});
    expect((await del(app, `/forget/fact/${FACT_ID}?mode=purge`)).status).toBe(400);
    expect(forget).not.toHaveBeenCalled();
  });

  it("no mode, or mode=soft, keeps the soft forget", async () => {
    for (const query of ["", "?mode=soft"]) {
      const { app, forget, hardDeleteFact } = await buildApp({});
      const res = await del(app, `/forget/fact/${FACT_ID}${query}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ forgotten: true });
      expect(forget).toHaveBeenCalledWith(FACT_ID, "fact", "soft", expect.anything(), undefined);
      expect(hardDeleteFact).not.toHaveBeenCalled();
    }
  });
});

/**
 * APP-008 (audit 2026-11-22). Measured live: a key whose ceiling was `public`
 * got 404 from DELETE /facts/:id for a `restricted` fact and 200
 * {"forgotten":true} from DELETE /forget/fact/:id, which closed it. Only the
 * event kind was checked against the ceiling.
 */
describe("APP-008 — DELETE /forget/:kind/:id honours the sensitivity ceiling for every kind", () => {
  it.each(["fact", "decision", "episode", "entity", "strategy", "workflow", "skill", "task", "reasoning"])(
    "a %s above the caller's ceiling is a 404 and is not forgotten",
    async (kind) => {
      const { app, forget } = await buildApp({ hiddenIds: [FACT_ID], maxSensitivity: "public" });
      const res = await del(app, `/forget/${kind}/${FACT_ID}`);
      expect(res.status).toBe(404);
      expect(forget).not.toHaveBeenCalled();
    }
  );

  it("the 404 reads like a missing row, not like a refusal", async () => {
    const { app } = await buildApp({ hiddenIds: [FACT_ID], maxSensitivity: "public" });
    const body = (await (await del(app, `/forget/fact/${FACT_ID}`)).json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("not_found");
    expect(body.error.message).not.toMatch(/ceiling|sensitiv/i);
  });

  it("a row at or below the ceiling is still forgotten", async () => {
    const { app, forget } = await buildApp({ hiddenIds: [], maxSensitivity: "internal" });
    const res = await del(app, `/forget/fact/${FACT_ID}`);
    expect(res.status).toBe(200);
    expect(forget).toHaveBeenCalledTimes(1);
  });
});
