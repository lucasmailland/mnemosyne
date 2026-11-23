/**
 * Tier A parity — `routes/session.ts`'s remaining `deps.core`-backed
 * handlers (design.md D3): POST /session/start, the no-`sessionBuffer`
 * fallback of POST /session/:id/turn, the no-`deps.storage` fallback of
 * POST /session/:id/discard, and the no-`sessionBuffer` fallback of
 * POST /session/:id/scratch.
 *
 * flatten-legacy-dual-core PR16: `POST /session/:id/collapse` parity is now
 * ALSO covered here (see the describe block at the bottom of this file).
 * PR10's blocker (documented above, preserved for history) is closed: the
 * real 8-step extraction pipeline (`packages/core/src/session/collapse.ts`)
 * is now exposed through the `MnemoCore` facade as
 * `collapseSession(args, auth)`, and `session.ts` calls
 * `deps.cognitive.collapseSession` instead of `deps.core.collapseSession`.
 * `session.ts` is REMOVED from the `legacy-core-usage.test.ts` allowlist by
 * this PR (the file's last remaining `deps.core` call site). The collapse
 * describe block below was written and merged green against a fake
 * `deps.cognitive.collapseSession` reproducing the exact same
 * close/throw/return contract the legacy `deps.core.collapseSession`
 * (`CoreLike`, `factory.ts`) exposed — same `{turnsProcessed,
 * anticipationAccuracy}` success shape, same `.code = "NOT_FOUND"` /
 * `.code = "LLM_UNAVAILABLE"` error codes — so this is a genuine
 * zero-route-logic-change port; only the call target moved from
 * `deps.core` to `deps.cognitive`.
 *
 * Written and merged green against the legacy `deps.core.{startSession,
 * appendTurn,discardSession}` (`CoreLike`) implementation FIRST
 * (flatten-legacy-dual-core PR10); the port commit in this same PR swaps
 * `startSession`/the turn-fallback/the scratch-fallback to `deps.storage`'s
 * existing/new v3 methods. ONE disclosed exception (documented inline at
 * that test): the turn-fallback's `metadata` forwarding is intentionally
 * dropped by the port, aligning it with the ALREADY-established
 * `sessionBuffer` branch in this same file (which never forwarded
 * `body.metadata` either) rather than preserving the now-inconsistent
 * legacy-only pass-through — `SessionTurn` has no v3 `metadata` field at all.
 * The discard-fallback's behavior deliberately changes from
 * `deps.core.discardSession` to a 503 `ServiceUnavailableError`, matching the
 * `!deps.storage` convention every OTHER handler in this file already uses
 * (`GET /session/list`, `GET /session/:id`, `POST /session/:id/pin`) — a new
 * test is added for this rather than mutating a legacy-path assertion.
 */
import { describe, it, expect, vi } from "vitest";
import bcrypt from "bcrypt";
import { BCRYPT_COST } from "../../auth.js";
import type { ApiKeyLookup } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import { buildMountHarness } from "../_mountHarness.js";
import { mountSession } from "../../routes/session.js";
import { makeMockCognitive } from "../helpers/mockCognitive.js";

const PLAINTEXT_KEY = "mns_live_sessionparitytest0001";
const WS_ID = "00000000-0000-0000-0000-000000000901";
const SESSION_ID = "sess_a23bcdef0123456789ghijkl";

async function makeKeyLookup(): Promise<ApiKeyLookup> {
  const keyHash = await bcrypt.hash(PLAINTEXT_KEY, BCRYPT_COST);
  return {
    listActive: async () => [{ id: "session-key-001", keyHash, workspaceId: WS_ID, scopes: [] }],
    findByLookupHash: undefined,
    setLookupHash: undefined,
    touch: async () => {},
  } as unknown as ApiKeyLookup;
}

function authed(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${PLAINTEXT_KEY}`, ...extra };
}

const NOW = "2026-06-20T00:00:00.000Z"; // determinism-ok: fixed fixture timestamp, not derived from Date.now()

function sessionRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    workspaceId: WS_ID,
    agentId: null,
    status: "active",
    openedAt: NOW,
    label: null,
    ...overrides,
  };
}

async function buildApp(storageOverrides: Record<string, unknown> = {}) {
  const createSession = vi.fn().mockResolvedValue(sessionRecord());
  const getSession = vi.fn().mockResolvedValue(sessionRecord());
  const listTurns = vi.fn().mockResolvedValue([]);
  const appendTurn = vi.fn().mockResolvedValue(undefined);
  const replaceSessionScratch = vi.fn().mockResolvedValue(true);
  const appendAuditEntry = vi.fn().mockResolvedValue(undefined);

  const deps = {
    storage: {
      createSession,
      getSession,
      listTurns,
      appendTurn,
      replaceSessionScratch,
      appendAuditEntry,
      ...storageOverrides,
    },
    apiKeys: await makeKeyLookup(),
  } as unknown as ServerDeps;
  const app = buildMountHarness(deps, [mountSession]);
  return { app, deps, createSession, getSession, listTurns, appendTurn, replaceSessionScratch };
}

async function buildAppNoStorage() {
  const deps = {
    apiKeys: await makeKeyLookup(),
  } as unknown as ServerDeps;
  const app = buildMountHarness(deps, [mountSession]);
  return { app };
}

describe("Tier A parity: POST /session/start", () => {
  it("returns 201 with the session shape", async () => {
    const { app } = await buildApp();
    const res = await app.request("/session/start", {
      method: "POST",
      headers: { ...authed(), "content-type": "application/json" },
      body: JSON.stringify({ agentId: "agent-x", label: "my session" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      agentId: string | null;
      status: string;
      label: string | null;
    };
    expect(body.id).toBe(SESSION_ID);
    expect(body.status).toBe("active");
  });

  it("forwards workspaceId/agentId/userId/label + stuffs actorId+actorType into metadata", async () => {
    const { app, createSession } = await buildApp();
    await app.request("/session/start", {
      method: "POST",
      headers: { ...authed(), "content-type": "application/json" },
      body: JSON.stringify({ agentId: "agent-x", label: "my session", metadata: { foo: "bar" } }),
    });
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WS_ID,
        agentId: "agent-x",
        userId: null,
        label: "my session",
        metadata: expect.objectContaining({ foo: "bar", actorType: "user" }),
      })
    );
  });
});

describe("Tier A parity: POST /session/:id/turn (no sessionBuffer fallback)", () => {
  it("returns 204 and forwards role/content to the append path", async () => {
    const { app, appendTurn } = await buildApp();
    const res = await app.request(`/session/${SESSION_ID}/turn`, {
      method: "POST",
      headers: { ...authed(), "content-type": "application/json" },
      body: JSON.stringify({ role: "user", content: "hello" }),
    });
    expect(res.status).toBe(204);
    expect(appendTurn).toHaveBeenCalledWith(
      SESSION_ID,
      expect.objectContaining({
        sessionId: SESSION_ID,
        workspaceId: WS_ID,
        role: "user",
        content: "hello",
      })
    );
  });

  it("returns 404 when the session doesn't exist", async () => {
    const { app } = await buildApp({
      getSession: vi.fn().mockResolvedValue(null),
    });
    const res = await app.request(`/session/${SESSION_ID}/turn`, {
      method: "POST",
      headers: { ...authed(), "content-type": "application/json" },
      body: JSON.stringify({ role: "user", content: "hello" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("Tier A parity: POST /session/:id/discard (no deps.storage fallback)", () => {
  // flatten-legacy-dual-core Slice 3c pt.1 (PR10): the legacy
  // `deps.core.discardSession` fallback is replaced by a straight 503 —
  // matching the `!deps.storage` convention every OTHER handler in this file
  // already uses. This is the ONLY observable behavior change; the
  // deps.storage-present branch (204 on success / 404 on missing session) is
  // pre-existing and untouched by this PR.
  it("returns 503 when no storage adapter is wired", async () => {
    const { app } = await buildAppNoStorage();
    const res = await app.request(`/session/${SESSION_ID}/discard`, {
      method: "POST",
      headers: authed(),
    });
    expect(res.status).toBe(503);
  });
});

describe("Tier A parity: POST /session/:id/scratch (no sessionBuffer fallback)", () => {
  it("returns 204 and forwards workspaceId/sessionId/scratch", async () => {
    const { app, replaceSessionScratch } = await buildApp();
    const res = await app.request(`/session/${SESSION_ID}/scratch`, {
      method: "POST",
      headers: { ...authed(), "content-type": "application/json" },
      body: JSON.stringify({ scratch: { step: 2 } }),
    });
    expect(res.status).toBe(204);
    expect(replaceSessionScratch).toHaveBeenCalledWith({
      workspaceId: WS_ID,
      sessionId: SESSION_ID,
      scratch: { step: 2 },
    });
  });

  it("returns 404 when the session doesn't exist", async () => {
    const { app } = await buildApp({ replaceSessionScratch: vi.fn().mockResolvedValue(false) });
    const res = await app.request(`/session/${SESSION_ID}/scratch`, {
      method: "POST",
      headers: { ...authed(), "content-type": "application/json" },
      body: JSON.stringify({ scratch: {} }),
    });
    expect(res.status).toBe(404);
  });
});

// ─── flatten-legacy-dual-core PR16: POST /session/:id/collapse ──────────────

function noopSpan() {
  return { setAttribute: () => {}, setStatus: () => {}, end: () => {} };
}

async function buildAppForCollapse(collapseSession: ReturnType<typeof vi.fn>) {
  const deps = {
    apiKeys: await makeKeyLookup(),
    telemetry: { startSpan: () => noopSpan() },
    cognitive: makeMockCognitive({ collapseSession }),
    // Classification is mandatory before legacy extraction; this fixture models
    // an explicitly unmanaged session rather than an absent storage adapter.
    storage: { getSession: vi.fn().mockResolvedValue(sessionRecord({ sourceHost: null })) },
  } as unknown as ServerDeps;
  const app = buildMountHarness(deps, [mountSession]);
  return { app };
}

describe("Tier A parity: POST /session/:id/collapse", () => {
  it("returns 202 accepted and forwards sessionId/workspaceId/policy to deps.cognitive.collapseSession", async () => {
    const collapseSession = vi
      .fn()
      .mockResolvedValue({ turnsProcessed: 4, anticipationAccuracy: 0.5 });
    const { app } = await buildAppForCollapse(collapseSession);
    const res = await app.request(`/session/${SESSION_ID}/collapse`, {
      method: "POST",
      headers: { ...authed(), "content-type": "application/json" },
      body: JSON.stringify({ strategy: "explicit", collapseHint: "wrap it up" }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      accepted: boolean;
      sessionId: string;
      resumed: boolean;
      status: string;
    };
    // P115: `status` is new and deliberate. This route used to answer
    // `accepted:true` whether the pipeline extracted knowledge or discarded the
    // session at a threshold gate, and the caller had no way to tell the two
    // apart. The mock above resolves without a status, which the handler reads
    // as "completed" — the back-compat default for an adapter predating the field.
    expect(body).toEqual({
      accepted: true,
      sessionId: SESSION_ID,
      resumed: false,
      status: "completed",
    });

    expect(collapseSession).toHaveBeenCalledTimes(1);
    const [args, auth] = collapseSession.mock.calls[0]!;
    expect(args).toMatchObject({
      sessionId: SESSION_ID,
      workspaceId: WS_ID,
      strategy: "explicit",
      collapseHint: "wrap it up",
    });
    // Real caller identity flows through (flatten-legacy-dual-core PR16 —
    // replaces the legacy factory's synthetic "system:collapse" actor).
    expect(auth).toMatchObject({
      workspaceId: WS_ID,
      scopes: expect.arrayContaining(["memory:write"]),
    });
  });

  it("returns 404 when deps.cognitive.collapseSession throws NOT_FOUND", async () => {
    const collapseSession = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("not found"), { code: "NOT_FOUND" }));
    const { app } = await buildAppForCollapse(collapseSession);
    const res = await app.request(`/session/${SESSION_ID}/collapse`, {
      method: "POST",
      headers: { ...authed(), "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });

  it("returns 503 (MNEMO_004) when deps.cognitive.collapseSession throws LLM_UNAVAILABLE", async () => {
    const collapseSession = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("LLM failed"), { code: "LLM_UNAVAILABLE" }));
    const { app } = await buildAppForCollapse(collapseSession);
    const res = await app.request(`/session/${SESSION_ID}/collapse`, {
      method: "POST",
      headers: { ...authed(), "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(503);
  });
});
