/**
 * SEC-1 / AUTH-ADMIN-KEYS-SUBSET — `POST /admin/keys` (and rotation) may only
 * hand out authority the caller already holds.
 *
 * Measured on 9a20d6ea: a key holding only `memory:read` + `admin:keys` minted
 * a key with `memory:hard_delete` (and every other scope), and that minted key
 * then physically deleted a fact its creator was refused. `*`/`root` were
 * accepted and stored too — and `*` is not inert: `/admin/harness/quiesce`
 * honours it.
 *
 * Rotation is the same hole by another door: rotating a key returns a fresh
 * plaintext secret carrying the OLD key's scopes and ceiling, so a narrow
 * `admin:keys` holder could rotate the owner's full-scope key and walk away
 * with its replacement.
 *
 * Pattern: OpenAPIHono + fake auth middleware + vi.fn() SQL client. Every
 * rejection must happen before the transaction opens (no INSERT, no bcrypt).
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, it, expect, vi } from "vitest";
import type { AuthVariables } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import { toErrorBody } from "../../errors.js";
import { mountKeys } from "../../routes/keys.js";

const WORKSPACE_ID = "00000000-0000-0000-0000-0000000000b1";
const OWNER_KEY_ID = "mk_ownerkey00112233";

function makeApp(opts: {
  scopes: string[];
  /** auth.ts hands role-narrowed scopes over as a Set on some paths. */
  scopesAsSet?: boolean;
  maxSensitivity?: string;
  /** Row returned to the rotate handler's SELECT (5th tx call). */
  rotateRow?: Record<string, unknown>;
}) {
  const app = new OpenAPIHono<{ Variables: AuthVariables }>();
  app.use("*", async (c, next) => {
    c.set("workspaceId", WORKSPACE_ID);
    c.set("apiKeyPrefix", "mk_live_");
    c.set("actorId", "mk_callerkey0011");
    c.set(
      "scopes",
      (opts.scopesAsSet ? new Set(opts.scopes) : opts.scopes) as unknown as ReadonlyArray<string>
    );
    if (opts.maxSensitivity) c.set("maxSensitivity", opts.maxSensitivity as never);
    await next();
  });
  app.onError((err, c) => {
    const { status, body } = toErrorBody(err);
    return c.json(body, status as Parameters<typeof c.json>[1]);
  });

  const inserts: unknown[][] = [];
  const fakeSql = vi.fn() as unknown as ServerDeps["metricsPgClient"];
  (fakeSql as unknown as Record<string, unknown>).array = (v: unknown) => v;
  const begin = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
    let n = 0;
    const tx = vi.fn().mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
      n++;
      if (strings.join("?").includes("INSERT INTO mnemo_api_keys")) inserts.push(values);
      if (n <= 4) return Promise.resolve([]);
      return Promise.resolve(opts.rotateRow ? [opts.rotateRow] : []);
    });
    (tx as unknown as Record<string, unknown>).array = (v: unknown) => v;
    return fn(tx);
  });
  (fakeSql as unknown as Record<string, unknown>).begin = begin;

  mountKeys(app, { metricsPgClient: fakeSql } as unknown as ServerDeps);
  return { app, begin, inserts };
}

async function createKey(app: OpenAPIHono<{ Variables: AuthVariables }>, body: object) {
  return app.request("/admin/keys", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label: "minted", ...body }),
  });
}

describe("POST /admin/keys — scopes must be a subset of the caller's (SEC-1)", () => {
  it("REGRESSION: read + admin:keys cannot mint memory:hard_delete — 403, nothing inserted", async () => {
    const { app, begin, inserts } = makeApp({ scopes: ["memory:read", "admin:keys"] });
    const res = await createKey(app, { scopes: ["memory:read", "memory:hard_delete"] });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { message?: string; details?: { disallowed?: string[] } };
    expect(JSON.stringify(body)).toContain("memory:hard_delete");
    expect(begin).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(0);
  });

  it("REGRESSION: the measured full-scope escalation is refused", async () => {
    const { app, begin } = makeApp({ scopes: ["memory:read", "admin:keys"] });
    const res = await createKey(app, {
      scopes: [
        "memory:read",
        "admin:keys",
        "admin:tenant",
        "admin:billing",
        "admin:workspace",
        "memory:hard_delete",
        "memory:delete",
        "federation:manage",
      ],
      keyKind: "user",
    });
    expect(res.status).toBe(403);
    expect(begin).not.toHaveBeenCalled();
  });

  it.each([["*"], ["root"], ["memory:*"]])(
    "unknown scope %s is a 400 even for a caller holding every real scope",
    async (bogus) => {
      const { app, begin } = makeApp({ scopes: ["memory:read", "admin:keys", bogus] });
      const res = await createKey(app, { scopes: ["memory:read", bogus] });
      expect(res.status).toBe(400);
      expect(JSON.stringify(await res.json())).toContain(bogus);
      expect(begin).not.toHaveBeenCalled();
    }
  );

  it("a subset of the caller's scopes is still minted (201, one INSERT)", async () => {
    const { app, inserts } = makeApp({
      scopes: ["memory:read", "memory:write", "admin:keys"],
    });
    const res = await createKey(app, { scopes: ["memory:read", "memory:write"] });
    expect(res.status).toBe(201);
    expect(inserts).toHaveLength(1);
    const body = (await res.json()) as { scopes: string[] };
    expect(body.scopes).toEqual(["memory:read", "memory:write"]);
  });

  it("works when the auth layer hands scopes over as a Set", async () => {
    const { app, begin } = makeApp({ scopes: ["memory:read", "admin:keys"], scopesAsSet: true });
    const denied = await createKey(app, { scopes: ["memory:hard_delete"] });
    expect(denied.status).toBe(403);
    expect(begin).not.toHaveBeenCalled();
    const allowed = await createKey(app, { scopes: ["memory:read"] });
    expect(allowed.status).toBe(201);
  });
});

describe("POST /admin/keys — sensitivity ceiling can only be narrowed", () => {
  it("a caller capped at internal cannot mint a confidential key — 403", async () => {
    const { app, begin } = makeApp({
      scopes: ["memory:read", "admin:keys"],
      maxSensitivity: "internal",
    });
    const res = await createKey(app, { scopes: ["memory:read"], maxSensitivity: "confidential" });
    expect(res.status).toBe(403);
    expect(begin).not.toHaveBeenCalled();
  });

  it("a capped caller that omits maxSensitivity mints a key with its own cap, not an uncapped one", async () => {
    const { app, inserts } = makeApp({
      scopes: ["memory:read", "admin:keys"],
      maxSensitivity: "internal",
    });
    const res = await createKey(app, { scopes: ["memory:read"] });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { maxSensitivity: string | null }).maxSensitivity).toBe(
      "internal"
    );
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toContain("internal");
  });

  it("a capped caller may still mint a lower ceiling", async () => {
    const { app } = makeApp({ scopes: ["memory:read", "admin:keys"], maxSensitivity: "internal" });
    const res = await createKey(app, { scopes: ["memory:read"], maxSensitivity: "public" });
    expect(res.status).toBe(201);
  });
});

describe("POST /admin/keys/:keyId/rotate — rotation cannot hand out more than the caller holds", () => {
  const ownerRow = {
    id: OWNER_KEY_ID,
    label: "owner",
    scopes: ["memory:read", "memory:write", "memory:hard_delete", "admin:keys"],
    plan: "free",
    ip_allowlist: [],
    expires_at: null,
    revoked_at: null,
    deprecated_at: null,
    max_sensitivity: null,
    user_id: null,
    tenant_id: null,
    key_kind: "workspace",
  };

  it("REGRESSION: read + admin:keys cannot rotate a key holding memory:hard_delete — 403, no new key", async () => {
    const { app, inserts } = makeApp({
      scopes: ["memory:read", "admin:keys"],
      rotateRow: ownerRow,
    });
    const res = await app.request(`/admin/keys/${OWNER_KEY_ID}/rotate`, { method: "POST" });
    expect(res.status).toBe(403);
    expect(inserts).toHaveLength(0);
  });

  it("a capped caller cannot rotate an uncapped key", async () => {
    const { app, inserts } = makeApp({
      scopes: ownerRow.scopes,
      maxSensitivity: "internal",
      rotateRow: ownerRow,
    });
    const res = await app.request(`/admin/keys/${OWNER_KEY_ID}/rotate`, { method: "POST" });
    expect(res.status).toBe(403);
    expect(inserts).toHaveLength(0);
  });

  it("rotating a key within the caller's authority still works (201)", async () => {
    const { app, inserts } = makeApp({ scopes: ownerRow.scopes, rotateRow: ownerRow });
    const res = await app.request(`/admin/keys/${OWNER_KEY_ID}/rotate`, { method: "POST" });
    expect(res.status).toBe(201);
    expect(inserts).toHaveLength(1);
  });
});

describe("POST /admin/keys — federation keys", () => {
  const caller = { scopes: ["memory:read", "memory:federation", "admin:keys"] };

  it("issues an mk_fed_ key, the class the federation peer gate requires", async () => {
    const { app, inserts } = makeApp(caller);
    const res = await createKey(app, { scopes: ["memory:federation"], federation: true });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; key: string };
    expect(body.key).toMatch(/^mk_fed_[a-f0-9]{32}$/);
    expect(body.id).toMatch(/^mk_fed_/);
    expect(inserts).toHaveLength(1);
  });

  it.each([
    ["more than memory:federation", { scopes: ["memory:federation", "memory:read"] }],
    ["another scope", { scopes: ["memory:read"] }],
    ["a test key", { scopes: ["memory:federation"], test: true }],
    ["a user key", { scopes: ["memory:federation"], keyKind: "user" }],
  ])("refuses %s (400, nothing inserted)", async (_name, extra) => {
    const { app, begin, inserts } = makeApp(caller);
    const res = await createKey(app, { federation: true, ...extra });
    expect(res.status).toBe(400);
    expect(begin).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(0);
  });

  it("rotating a federation key gives another federation key", async () => {
    const fedRow = {
      id: "mk_fed_0011223344556677",
      scopes: ["memory:federation"],
      max_sensitivity: null,
      key_kind: "workspace",
      revoked_at: null,
      deprecated_at: null,
      expires_at: null,
      label: "peer",
      name: "peer",
      plan: "free",
      ip_allowlist: [],
      user_id: null,
      tenant_id: null,
      workspace_id: WORKSPACE_ID,
    };
    const { app } = makeApp({ ...caller, rotateRow: fedRow });
    const res = await app.request(`/admin/keys/${fedRow.id}/rotate`, { method: "POST" });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { newKey: string }).newKey).toMatch(/^mk_fed_/);
  });
});
