/**
 * Accounts stage A: a key bound to a disabled user stops authenticating on
 * every path that resolves a key, not only HTTP bearer (auth.ts, covered in
 * dashboard-session-live.test.ts): gRPC, the WebSocket upgrade and
 * /health/deep. All of them use keyUserAllowed (auth-evaluate.ts).
 */
import { Hono } from "hono";
import bcrypt from "bcrypt";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Code, ConnectError, createClient, createRouterTransport } from "@connectrpc/connect";
import { MnemosyneService } from "../../gen/mnemosyne_pb.js";
import { createAuthInterceptor, createMnemosyneRoutes } from "../../grpc.js";
import { authenticateWsToken } from "../../ws.js";
import { mountProbes } from "../../routes/health.js";
import { keyUserAllowed } from "../../auth-evaluate.js";
import { UserStatusService, type UserStatus } from "../../user-status.js";
import type { ApiKeyLookup } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import { makeMockCognitive } from "../helpers/mockCognitive.js";

const WS = "00000000-0000-0000-0000-000000000001";
const USER = "usr-001";
const TOKEN = "uk_live_1234567890123456789012";
const LEGACY = "mns_live_abcdefghijklmnopqrstuv";

const enabled = (overrides: Partial<UserStatus> = {}): UserStatus => ({
  disabledAt: null,
  sessionsValidAfter: new Date(0),
  isSuperadmin: false,
  ...overrides,
});

async function fixture(scopes: string[] = ["memory:read"]) {
  const statuses = new Map<string, UserStatus | null>([[USER, enabled()]]);
  const state = { error: null as Error | null };
  const userStatus = new UserStatusService({
    load: async (userId) => {
      if (state.error) throw state.error;
      return statuses.get(userId) ?? null;
    },
  });
  const apiKeys: ApiKeyLookup = {
    listActive: async () => [
      {
        id: "uk-1",
        keyHash: await bcrypt.hash(TOKEN, 4),
        workspaceId: WS,
        scopes,
        plan: "pro",
        userId: USER,
        keyKind: "user",
      },
      {
        id: "k-legacy",
        keyHash: await bcrypt.hash(LEGACY, 4),
        workspaceId: WS,
        scopes,
        plan: "pro",
      },
    ],
    touch: vi.fn(),
  };
  const disable = () => {
    statuses.set(USER, enabled({ disabledAt: new Date() })); // determinism-ok: live session checks read the wall clock
    userStatus.invalidate(USER);
  };
  const enable = () => {
    statuses.set(USER, enabled());
    userStatus.invalidate(USER);
  };
  return { statuses, state, userStatus, apiKeys, disable, enable };
}

describe("keyUserAllowed", () => {
  it("allows keys without a user or without a status service, refuses disabled and unknown users, throws on error", async () => {
    const f = await fixture();
    expect(await keyUserAllowed(f.userStatus, null)).toBe(true);
    expect(await keyUserAllowed(undefined, USER)).toBe(true);
    expect(await keyUserAllowed(f.userStatus, USER)).toBe(true);
    expect(await keyUserAllowed(f.userStatus, "usr-unknown")).toBe(false);
    f.disable();
    expect(await keyUserAllowed(f.userStatus, USER)).toBe(false);
    f.state.error = new Error("database offline");
    f.userStatus.invalidate(USER);
    await expect(keyUserAllowed(f.userStatus, USER)).rejects.toThrow();
  });
});

async function grpc(workspaceRegion?: string) {
  const f = await fixture();
  const deps = {
    apiKeys: f.apiKeys,
    userStatus: f.userStatus,
    // A tagged-template stand-in for the region lookup's one query.
    ...(workspaceRegion !== undefined
      ? { metricsPgClient: async () => [{ region: workspaceRegion }] }
      : {}),
    cognitive: makeMockCognitive({ recall: vi.fn().mockResolvedValue({ hits: [] }) }),
  } as unknown as ServerDeps;
  const client = createClient(
    MnemosyneService,
    createRouterTransport((r) => createMnemosyneRoutes(r, deps), {
      router: { interceptors: [createAuthInterceptor(deps)] },
    })
  );
  const call = async (token = TOKEN): Promise<Code | "ok"> => {
    try {
      await client.recall(
        { query: "x", limit: 1 },
        { headers: { authorization: `Bearer ${token}` } }
      );
      return "ok";
    } catch (err) {
      return ConnectError.from(err).code;
    }
  };
  return { f, call };
}

describe("gRPC interceptor", () => {
  it("refuses a disabled user's key as Unauthenticated and lets it in again after re-enable", async () => {
    const { f, call } = await grpc();
    expect(await call()).toBe("ok");
    f.disable();
    expect(await call()).toBe(Code.Unauthenticated);
    f.enable();
    expect(await call()).toBe("ok");
  });

  it("fails closed with Unavailable when the status cannot be read, keys without a user unaffected", async () => {
    const { f, call } = await grpc();
    f.state.error = new Error("database offline");
    expect(await call()).toBe(Code.Unavailable);
    expect(await call(LEGACY)).toBe("ok");
  });
});

describe("WebSocket upgrade", () => {
  it("closes 1008 for a disabled user's key and 1011 when the status is unreadable", async () => {
    const f = await fixture();
    const deps = { apiKeys: f.apiKeys, userStatus: f.userStatus };
    expect(await authenticateWsToken(deps, TOKEN)).toMatchObject({ ok: true, workspaceId: WS });
    f.disable();
    expect(await authenticateWsToken(deps, TOKEN)).toMatchObject({ ok: false, code: 1008 });
    f.state.error = new Error("database offline");
    f.userStatus.invalidate(USER);
    expect(await authenticateWsToken(deps, TOKEN)).toMatchObject({ ok: false, code: 1011 });
    expect(await authenticateWsToken(deps, LEGACY)).toMatchObject({ ok: true, workspaceId: WS });
    f.state.error = null;
    f.enable();
    expect(await authenticateWsToken(deps, TOKEN)).toMatchObject({ ok: true, workspaceId: WS });
  });
});

describe("/health/deep", () => {
  it("answers a disabled user's admin key like an invalid token, and 503 when the status is unreadable", async () => {
    const f = await fixture(["memory:admin"]);
    const app = new Hono();
    mountProbes(app, {
      apiKeys: f.apiKeys,
      userStatus: f.userStatus,
      core: { ping: async () => {} },
      bus: { emit: () => {} },
    } as unknown as ServerDeps);
    const deep = () =>
      app.request("/health/deep", { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect([401, 403]).not.toContain((await deep()).status);
    f.disable();
    const disabled = await deep();
    expect(disabled.status).toBe(401);
    expect(await disabled.json()).toEqual({ error: "invalid_or_expired_token" });
    f.state.error = new Error("database offline");
    f.userStatus.invalidate(USER);
    expect((await deep()).status).toBe(503);
  });
});

describe("region lock on the non-HTTP transports", () => {
  afterEach(() => {
    delete process.env.MNEMO_REGION;
  });

  it("gRPC refuses a workspace pinned to another region with PermissionDenied", async () => {
    const { call } = await grpc("eu-west-1");
    process.env.MNEMO_REGION = "us-east-1";
    expect(await call()).toBe(Code.PermissionDenied);
    process.env.MNEMO_REGION = "eu-west-1";
    expect(await call()).toBe("ok");
  });

  it("a WebSocket upgrade closes 1008 for another region and 1011 when the lookup fails", async () => {
    const f = await fixture();
    let fail = false;
    const deps = {
      apiKeys: f.apiKeys,
      userStatus: f.userStatus,
      lookupRegion: async () => {
        if (fail) throw new Error("database offline");
        return "eu-west-1";
      },
    };
    process.env.MNEMO_REGION = "us-east-1";
    expect(await authenticateWsToken(deps, TOKEN)).toMatchObject({ ok: false, code: 1008 });
    process.env.MNEMO_REGION = "eu-west-1";
    expect(await authenticateWsToken(deps, TOKEN)).toMatchObject({ ok: true, workspaceId: WS });
    fail = true;
    expect(await authenticateWsToken(deps, TOKEN)).toMatchObject({ ok: false, code: 1011 });
    delete process.env.MNEMO_REGION;
    expect(await authenticateWsToken(deps, TOKEN)).toMatchObject({ ok: true, workspaceId: WS });
  });
});
