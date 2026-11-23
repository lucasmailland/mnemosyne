/**
 * SEC-4 (resource half) — DELETE /facts/:id/hard leaves a trace and fails closed.
 *
 * Measured on 9a20d6ea: a hard delete physically removed the row and wrote no
 * audit entry and no deletion-log row, so the one path that truly destroys
 * data left nothing behind. It also answered `deleted: true` when the adapter
 * had no hard-delete capability or skipped a mid-consolidation row, and it
 * deleted facts above the caller's sensitivity ceiling (200 where GET says 404).
 *
 * This is resource deletion only. Person-wide GDPR erasure (destroying a
 * subject's keys) is a separate contract and is not exposed here.
 */
import { describe, it, expect, vi } from "vitest";
import bcrypt from "bcrypt";
import type { ApiKeyLookup } from "../../auth.js";
import { BCRYPT_COST } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import { mountFacts } from "../../routes/facts.js";
import { buildMountHarness } from "../_mountHarness.js";

const PLAINTEXT_KEY = "mns_live_facthardaudittest00000001";
const WS_ID = "00000000-0000-0000-0000-0000000000d4";
const FACT_ID = "11111111-2222-4333-8444-555555555555";

function factRecord(sensitivity = "internal") {
  const now = new Date("2026-10-17T00:00:00.000Z");
  return {
    id: FACT_ID,
    workspaceId: WS_ID,
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
  sensitivity?: string;
  hardDeleteFact?: ReturnType<typeof vi.fn> | null;
}) {
  const keyHash = await bcrypt.hash(PLAINTEXT_KEY, BCRYPT_COST);
  const apiKeys = {
    listActive: async () => [
      {
        id: "key-purger",
        keyHash,
        workspaceId: WS_ID,
        scopes: ["memory:read", "memory:hard_delete"],
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
  const deps = {
    storage: {
      getFact: vi.fn().mockResolvedValue(factRecord(opts.sensitivity)),
      ...(hardDeleteFact ? { hardDeleteFact } : {}),
      appendAuditEntry,
    },
    apiKeys,
  } as unknown as ServerDeps;
  return { app: buildMountHarness(deps, [mountFacts]), hardDeleteFact, appendAuditEntry };
}

function hardDelete(app: Awaited<ReturnType<typeof buildApp>>["app"]) {
  return app.request(`/facts/${FACT_ID}/hard`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${PLAINTEXT_KEY}` },
  });
}

describe("SEC-4 — DELETE /facts/:id/hard is audited and fails closed", () => {
  it("REGRESSION: the delete carries its actor so the deletion log is written in the same transaction", async () => {
    const { app, hardDeleteFact } = await buildApp({});
    const res = await hardDelete(app);
    expect(res.status).toBe(200);
    expect(hardDeleteFact).toHaveBeenCalledWith(
      FACT_ID,
      WS_ID,
      expect.objectContaining({ actorId: "key:key-purger" })
    );
  });

  it("REGRESSION: a terminal hard_delete audit entry is emitted for the fact", async () => {
    const { app, appendAuditEntry } = await buildApp({});
    expect((await hardDelete(app)).status).toBe(200);
    expect(appendAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WS_ID,
        actorId: "key:key-purger",
        action: "hard_delete",
        resourceKind: "fact",
        resourceId: FACT_ID,
        isTerminal: true,
      })
    );
  });

  it("a fact above the caller's ceiling is a 404 (S6) and is not deleted", async () => {
    const { app, hardDeleteFact, appendAuditEntry } = await buildApp({
      sensitivity: "confidential",
    });
    expect((await hardDelete(app)).status).toBe(404);
    expect(hardDeleteFact).not.toHaveBeenCalled();
    expect(appendAuditEntry).not.toHaveBeenCalled();
  });

  it("a row the adapter refused to delete (mid-consolidation) is a 409, not deleted:true", async () => {
    const { app, appendAuditEntry } = await buildApp({
      hardDeleteFact: vi.fn().mockResolvedValue(false),
    });
    expect((await hardDelete(app)).status).toBe(409);
    expect(appendAuditEntry).not.toHaveBeenCalled();
  });

  it("an adapter with no hard-delete capability fails closed (501) instead of claiming success", async () => {
    const { app, appendAuditEntry } = await buildApp({ hardDeleteFact: null });
    expect((await hardDelete(app)).status).toBe(501);
    expect(appendAuditEntry).not.toHaveBeenCalled();
  });
});
