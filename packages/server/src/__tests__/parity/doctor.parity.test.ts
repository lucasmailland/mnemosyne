/**
 * Tier A parity — GET /doctor (design.md D3).
 *
 * HTTP characterization contract for `packages/server/src/routes/doctor.ts`'s
 * `connectivity` check. Written and merged green against the legacy
 * `deps.core.ping()` (`CoreLike`) implementation FIRST (flatten-legacy-dual-core
 * PR6); the port commit in this same PR then swapped the check to
 * `deps.storage.healthCheck()` (v3 `StorageAdapter`) with ZERO changes to any
 * `expect(...)` line below — only `buildApp`'s deps-fake wiring changed
 * (`core: { ping }` → `storage: { healthCheck }`), per D3's explicit
 * allowance. Asserts only the observable contract: status matrix, response
 * key set/types (via `contracts/doctor.schema.json`), and the connectivity
 * check's ok/error branches. The other 5 checks (app_user_grants,
 * schema_shadows, migration_version, embedding_backlog, workspace_id_valid)
 * are already infra-agnostic (`deps.metricsPgClient`, unaffected by this
 * port) and are exhaustively covered by the pre-existing `doctor.test.ts` —
 * not duplicated here.
 */
import { describe, it, expect, vi } from "vitest";
import bcrypt from "bcrypt";
import { BCRYPT_COST } from "../../auth.js";
import type { ApiKeyLookup } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import { buildMountHarness } from "../_mountHarness.js";
import { loadSchema, validate } from "../_schemaValidate.js";
import { mountDoctor } from "../../routes/doctor.js";

vi.mock("@mnemo-ai/adapter-postgres/migrate", () => ({
  listMigrationFilenames: vi.fn().mockResolvedValue(["0075.sql"]),
}));

const PLAINTEXT_KEY = "mns_live_doctorparitytest0000001";
const WS_ID = "00000000-0000-0000-0000-000000000d01";

async function makeKeyLookup(): Promise<ApiKeyLookup> {
  const keyHash = await bcrypt.hash(PLAINTEXT_KEY, BCRYPT_COST);
  return {
    listActive: async () => [{ id: "doctor-key-001", keyHash, workspaceId: WS_ID, scopes: [] }],
    findByLookupHash: undefined,
    setLookupHash: undefined,
    touch: async () => {},
  } as unknown as ApiKeyLookup;
}

function authed(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${PLAINTEXT_KEY}`, ...extra };
}

async function buildApp(
  healthCheck: () => Promise<{ status: string; latencyMs: number }> = vi
    .fn()
    .mockResolvedValue({ status: "ok", latencyMs: 0 })
) {
  const deps = {
    storage: { healthCheck },
    apiKeys: await makeKeyLookup(),
    // metricsPgClient intentionally absent — the other 5 checks degrade to
    // "unknown" (already covered by doctor.test.ts); this file isolates
    // connectivity's own contract only.
  } as unknown as ServerDeps;
  const app = buildMountHarness(deps, [mountDoctor]);
  return { app, deps, healthCheck };
}

describe("Tier A parity: GET /doctor", () => {
  it("returns 401 with no bearer token", async () => {
    const { app } = await buildApp();
    const res = await app.request("/doctor");
    expect(res.status).toBe(401);
  });

  it("returns 200 conforming to doctor.schema.json when connectivity is healthy", async () => {
    const doctorSchema = loadSchema("doctor");
    const { app } = await buildApp();
    const res = await app.request("/doctor", { headers: authed() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown;
    const err = validate(body, doctorSchema);
    expect(err).toBeNull();
  });

  it("connectivity check calls deps.core.ping() and reports ok on success", async () => {
    const { app, healthCheck } = await buildApp();
    const res = await app.request("/doctor", { headers: authed() });
    const body = (await res.json()) as { checks: { name: string; status: string }[] };
    expect(healthCheck).toHaveBeenCalledTimes(1);
    const connectivity = body.checks.find((c) => c.name === "connectivity");
    expect(connectivity?.status).toBe("ok");
  });

  it("connectivity check reports error with the thrown message when deps.core.ping() rejects", async () => {
    const { app } = await buildApp(vi.fn().mockRejectedValue(new Error("connection refused")));
    const res = await app.request("/doctor", { headers: authed() });
    expect(res.status).toBe(200); // always 200 — caller checks status field
    const body = (await res.json()) as {
      status: string;
      checks: { name: string; status: string; message: string }[];
    };
    const connectivity = body.checks.find((c) => c.name === "connectivity");
    expect(connectivity?.status).toBe("error");
    expect(connectivity?.message).toContain("connection refused");
  });
});
