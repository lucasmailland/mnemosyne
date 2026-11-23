/**
 * Tier A parity — GET /audit (design.md D3).
 *
 * HTTP characterization contract for `packages/server/src/routes/audit.ts`.
 * Written and merged green against the legacy `deps.core.audit` (`CoreLike`)
 * implementation FIRST (flatten-legacy-dual-core PR6); the port commit in
 * this same PR then swapped the route to `deps.storage.getAuditFeed`
 * (v3 `StorageAdapter`) with ZERO changes to any `expect(...)` line below —
 * only `buildApp`'s deps-fake wiring changed (`core: { audit }` →
 * `storage: { getAuditFeed }`), per D3's explicit allowance. Asserts only
 * the observable contract: status matrix, response key set/types (via
 * `contracts/audit.schema.json`), and query-param forwarding.
 */
import { describe, it, expect, vi } from "vitest";
import bcrypt from "bcrypt";
import { BCRYPT_COST } from "../../auth.js";
import type { ApiKeyLookup } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import { buildMountHarness } from "../_mountHarness.js";
import { loadSchema, validate } from "../_schemaValidate.js";
import { mountAudit } from "../../routes/audit.js";

const PLAINTEXT_KEY = "mns_live_auditparitytest00000001";
const WS_ID = "00000000-0000-0000-0000-000000000a01";

async function makeKeyLookup(): Promise<ApiKeyLookup> {
  const keyHash = await bcrypt.hash(PLAINTEXT_KEY, BCRYPT_COST);
  return {
    listActive: async () => [{ id: "audit-key-001", keyHash, workspaceId: WS_ID, scopes: [] }],
    findByLookupHash: undefined,
    setLookupHash: undefined,
    touch: async () => {},
  } as unknown as ApiKeyLookup;
}

function authed(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${PLAINTEXT_KEY}`, ...extra };
}

const NOW = "2026-06-20T00:00:00.000Z"; // determinism-ok: fixed fixture timestamp, not derived from Date.now()

function auditEntry(id: string) {
  return {
    id: `forget_${id}`,
    factId: id,
    factStatement: "user prefers dark mode",
    factSubject: "user",
    factKind: "preference",
    action: "forgotten" as const,
    actorKind: "user" as const,
    actorName: null,
    timestamp: NOW,
    revertible: true,
  };
}

async function buildApp(audit = vi.fn().mockResolvedValue([auditEntry("fact_1")])) {
  const deps = {
    storage: { getAuditFeed: audit },
    apiKeys: await makeKeyLookup(),
  } as unknown as ServerDeps;
  const app = buildMountHarness(deps, [mountAudit]);
  return { app, deps, audit };
}

describe("Tier A parity: GET /audit", () => {
  it("returns 401 with no bearer token", async () => {
    const { app } = await buildApp();
    const res = await app.request("/audit");
    expect(res.status).toBe(401);
  });

  it("returns 200 with items conforming to audit.schema.json, plus total/available", async () => {
    const auditSchema = loadSchema("audit");
    const { app } = await buildApp();
    const res = await app.request("/audit", { headers: authed() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; total: number; available: true };
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.total).toBe(body.items.length);
    expect(body.available).toBe(true);
    for (const item of body.items) {
      const err = validate(item, auditSchema);
      expect(err).toBeNull();
    }
  });

  it("forwards workspaceId + default limit (20) to deps.core.audit", async () => {
    const { app, audit } = await buildApp();
    await app.request("/audit", { headers: authed() });
    // maxSensitivity: the caller's ceiling (default internal).
    expect(audit).toHaveBeenCalledWith({
      workspaceId: WS_ID,
      limit: 20,
      maxSensitivity: "internal",
    });
  });

  it("forwards actorKind + from + to + q query params", async () => {
    const { app, audit } = await buildApp();
    await app.request(
      "/audit?actorKind=system&from=2026-01-01T00%3A00%3A00Z&to=2026-06-01T00%3A00%3A00Z&q=dark&limit=5",
      { headers: authed() }
    );
    expect(audit).toHaveBeenCalledWith({
      workspaceId: WS_ID,
      limit: 5,
      maxSensitivity: "internal",
      actorKind: "system",
      from: "2026-01-01T00:00:00Z",
      to: "2026-06-01T00:00:00Z",
      q: "dark",
    });
  });

  it("returns 400 on an invalid actorKind enum value", async () => {
    const { app } = await buildApp();
    const res = await app.request("/audit?actorKind=robot", { headers: authed() });
    expect(res.status).toBe(400);
  });

  it("returns 400 when limit exceeds the max (100)", async () => {
    const { app } = await buildApp();
    const res = await app.request("/audit?limit=101", { headers: authed() });
    expect(res.status).toBe(400);
  });

  it("returns an empty items array with total 0 when the store has no matches", async () => {
    const { app } = await buildApp(vi.fn().mockResolvedValue([]));
    const res = await app.request("/audit", { headers: authed() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; total: number };
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
  });
});
