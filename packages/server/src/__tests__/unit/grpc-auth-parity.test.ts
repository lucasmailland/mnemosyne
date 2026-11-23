/**
 * AUTH-GRPC-PARITY — one API key has the same power over gRPC as over HTTP.
 *
 * The interceptor now runs the evaluator HTTP uses (auth-evaluate.ts) and
 * HTTP's scope decision (decideScopeAccess):
 *   G1  — an empty-scope key is denied, unless MNEMO_ALLOW_LEGACY_FULL_SCOPE;
 *   G1b — the 7 streaming RPCs require the scope their HTTP equivalent does;
 *   G2  — a user-bound key is narrowed by its role in its own workspace;
 *   G3  — a deprecated key dies at its sunset and advertises it before;
 *   and x-workspace-id metadata other than the key's own is refused, not
 *   silently ignored, since this transport does not switch workspaces.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  Code,
  ConnectError,
  createClient,
  createRouterTransport,
  type Client,
} from "@connectrpc/connect";
import bcrypt from "bcrypt";
import { MnemosyneService } from "../../gen/mnemosyne_pb.js";
import { createMnemosyneRoutes, createAuthInterceptor } from "../../grpc.js";
import type { ServerDeps } from "../../deps.js";
import { authFailuresTotal } from "../../metrics/index.js";
import { makeMockCognitive } from "../helpers/mockCognitive.js";

const WS = "00000000-0000-0000-0000-000000000001";
const OTHER = "00000000-0000-0000-0000-000000000002";
const TOKEN = "mns_live_abcdefghijklmnopqrstu";
const NOW = Date.parse("2026-10-16T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

type Svc = Client<typeof MnemosyneService>;
type Row = {
  scopes: string[];
  userId?: string | null;
  deprecatedAt?: Date | null;
  ipAllowlist?: string[];
};

async function makeDeps(row: Row, extra: Record<string, unknown> = {}) {
  const apiKeys = {
    listActive: vi.fn().mockResolvedValue([]),
    findByLookupHash: vi.fn().mockResolvedValue({
      id: "k1",
      keyHash: await bcrypt.hash(TOKEN, 1),
      workspaceId: WS,
      plan: "pro",
      ...row,
    }),
    touch: vi.fn(),
    ...extra,
  };
  const remember = vi.fn().mockResolvedValue({ id: "f1", kind: "fact", staged: false });
  const recall = vi.fn().mockResolvedValue({ hits: [] });
  const deps = {
    apiKeys,
    cognitive: makeMockCognitive({ remember, recall }),
  } as unknown as ServerDeps;
  return { deps, remember, recall };
}

function clientFor(deps: ServerDeps, mod = { createMnemosyneRoutes, createAuthInterceptor }) {
  const transport = createRouterTransport((r) => mod.createMnemosyneRoutes(r, deps), {
    router: { interceptors: [mod.createAuthInterceptor(deps)] },
  });
  return createClient(MnemosyneService, transport);
}

const auth = (extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${TOKEN}`,
  ...extra,
});

async function codeOf(run: () => Promise<unknown>): Promise<Code | "ok"> {
  try {
    await run();
    return "ok";
  } catch (err) {
    return ConnectError.from(err).code;
  }
}

async function* none<T>(): AsyncGenerator<T> {}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of stream) break;
}

/** One minimal call per RPC. A call the interceptor lets through may still fail in its handler. */
const CALLS: Record<string, (c: Svc, headers: Record<string, string>) => Promise<unknown>> = {
  Recall: (c, headers) => c.recall({ query: "x", limit: 1 }, { headers }),
  Remember: (c, headers) => c.remember({ content: "x" }, { headers }),
  ResolveReasoning: (c, headers) => c.resolveReasoning({}, { headers }),
  CreateTask: (c, headers) => c.createTask({}, { headers }),
  UpdateTask: (c, headers) => c.updateTask({}, { headers }),
  RecordEvent: (c, headers) => c.recordEvent({}, { headers }),
  Forget: (c, headers) => c.forget({}, { headers }),
  RecordReasoning: (c, headers) => c.recordReasoning({}, { headers }),
  GetHealth: (c, headers) => c.getHealth({}, { headers }),
  SelfEdit: (c, headers) => c.selfEdit({}, { headers }),
  WatchMemory: (c, headers) => drain(c.watchMemory({}, { headers })),
  WatchTasks: (c, headers) => drain(c.watchTasks({}, { headers })),
  StreamHealth: (c, headers) => drain(c.streamHealth({}, { headers })),
  IngestBatch: (c, headers) => c.ingestBatch(none(), { headers }),
  ImportMemory: (c, headers) => c.importMemory(none(), { headers }),
  Session: (c, headers) => drain(c.session(none(), { headers })),
  FederationSync: (c, headers) => drain(c.federationSync(none(), { headers })),
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete process.env["MNEMO_ALLOW_LEGACY_FULL_SCOPE"];
  delete process.env["MNEMO_DISABLE_WORKSPACE_ROLE_SCOPES"];
});

describe("G1 — empty scopes", () => {
  it("the call table covers every RPC of the service", () => {
    expect(Object.keys(CALLS).sort()).toEqual(MnemosyneService.methods.map((m) => m.name).sort());
  });

  it.each(Object.keys(CALLS))("denies an empty-scope key on %s", async (rpc) => {
    const { deps } = await makeDeps({ scopes: [] });
    expect(await codeOf(() => CALLS[rpc]!(clientFor(deps), auth()))).toBe(Code.PermissionDenied);
  });

  it("lets an empty-scope key through with MNEMO_ALLOW_LEGACY_FULL_SCOPE=true", async () => {
    process.env["MNEMO_ALLOW_LEGACY_FULL_SCOPE"] = "true";
    const { deps, remember } = await makeDeps({ scopes: [] });
    await clientFor(deps).remember({ content: "x" }, { headers: auth() });
    expect(remember).toHaveBeenCalledTimes(1);
  });
});

describe("G1b — the streaming RPCs require the scope HTTP does", () => {
  it.each([
    ["WatchMemory", "memory:subscribe"],
    ["WatchTasks", "memory:subscribe"],
    ["StreamHealth", "memory:subscribe"],
    ["IngestBatch", "memory:write"],
    ["ImportMemory", "memory:write"],
    ["Session", "memory:write"],
    ["FederationSync", "memory:federation"],
  ])("denies %s to a key without %s", async (rpc, required) => {
    const everyOther = [
      "memory:read",
      "memory:write",
      "memory:subscribe",
      "memory:federation",
      "memory:delete",
      "memory:self_edit",
    ].filter((s) => s !== required);
    const { deps } = await makeDeps({ scopes: everyOther });
    expect(await codeOf(() => CALLS[rpc]!(clientFor(deps), auth()))).toBe(Code.PermissionDenied);
  });

  it("lets a memory:write key import and ingest", async () => {
    const { deps } = await makeDeps({ scopes: ["memory:write"] });
    const client = clientFor(deps);
    expect(await codeOf(() => CALLS["IngestBatch"]!(client, auth()))).toBe("ok");
    expect(await codeOf(() => CALLS["ImportMemory"]!(client, auth()))).toBe("ok");
  });

  it("keeps the unary mappings: a memory:read key still recalls but cannot remember", async () => {
    const { deps, recall } = await makeDeps({ scopes: ["memory:read"] });
    const client = clientFor(deps);
    await client.recall({ query: "x", limit: 1 }, { headers: auth() });
    expect(recall).toHaveBeenCalledTimes(1);
    expect(await codeOf(() => CALLS["Remember"]!(client, auth()))).toBe(Code.PermissionDenied);
  });
});

describe("G2 — role narrowing in the key's own workspace", () => {
  const demoted = () => ({ getWorkspaceMemberRole: vi.fn().mockResolvedValue("read") });

  it("denies a write to a user-bound key whose role is read, and still serves a read", async () => {
    const extra = demoted();
    const { deps, remember, recall } = await makeDeps(
      { scopes: ["memory:read", "memory:write"], userId: "usr-1" },
      extra
    );
    const client = clientFor(deps);

    expect(await codeOf(() => CALLS["Remember"]!(client, auth()))).toBe(Code.PermissionDenied);
    expect(remember).not.toHaveBeenCalled();
    await client.recall({ query: "x", limit: 1 }, { headers: auth() });
    expect(recall).toHaveBeenCalledTimes(1);
    expect(extra.getWorkspaceMemberRole).toHaveBeenCalledWith("usr-1", WS);
  });

  it("fails open when the user has no membership row in its own workspace", async () => {
    const { deps, remember } = await makeDeps(
      { scopes: ["memory:read", "memory:write"], userId: "usr-1" },
      { getWorkspaceMemberRole: vi.fn().mockResolvedValue(null) }
    );
    await clientFor(deps).remember({ content: "x" }, { headers: auth() });
    expect(remember).toHaveBeenCalledTimes(1);
  });

  it("does not narrow with MNEMO_DISABLE_WORKSPACE_ROLE_SCOPES=true", async () => {
    process.env["MNEMO_DISABLE_WORKSPACE_ROLE_SCOPES"] = "true";
    vi.resetModules();
    const fresh = await import("../../grpc.js");
    const { deps, remember } = await makeDeps(
      { scopes: ["memory:read", "memory:write"], userId: "usr-1" },
      demoted()
    );
    await clientFor(deps, fresh).remember({ content: "x" }, { headers: auth() });
    expect(remember).toHaveBeenCalledTimes(1);
  });
});

describe("G2 — the SelfEdit memory:admin override sees the narrowed scopes", () => {
  async function replaceForeignFact(role: string) {
    const { deps } = await makeDeps(
      { scopes: ["memory:self_edit", "memory:admin"], userId: "usr-1" },
      { getWorkspaceMemberRole: vi.fn().mockResolvedValue(role) }
    );
    const foreign = {
      id: "fact-1",
      workspaceId: WS,
      actorId: "another-owner",
      userId: null,
      status: "active",
      validTo: null,
      sensitivity: "internal",
      statement: "old",
    };
    const replaceFact = vi
      .fn()
      .mockResolvedValue({ previous: foreign, replacement: { id: "fact-2" } });
    (deps as unknown as { storage: unknown }).storage = {
      getFact: vi.fn().mockResolvedValue(foreign),
      replaceFact,
      appendAuditEntry: vi.fn().mockResolvedValue(undefined),
    };
    const code = await codeOf(() =>
      clientFor(deps).selfEdit(
        { action: "replace", targetId: "fact-1", content: "new", reason: "correction" },
        { headers: auth() }
      )
    );
    return { code, replaceFact };
  }

  it("lets a workspace admin replace a fact another key owns", async () => {
    const { code, replaceFact } = await replaceForeignFact("admin");
    expect(code).toBe("ok");
    expect(replaceFact).toHaveBeenCalledTimes(1);
  });

  it("does not let a key whose role is write use its memory:admin there", async () => {
    const { code, replaceFact } = await replaceForeignFact("write");
    expect(code).toBe(Code.NotFound);
    expect(replaceFact).not.toHaveBeenCalled();
  });
});

describe("G3 — deprecation sunset", () => {
  it("rejects a key past its 7-day sunset as unauthenticated", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    const { deps, remember } = await makeDeps({
      scopes: ["memory:write"],
      deprecatedAt: new Date(NOW - 8 * DAY),
    });
    expect(await codeOf(() => CALLS["Remember"]!(clientFor(deps), auth()))).toBe(
      Code.Unauthenticated
    );
    expect(remember).not.toHaveBeenCalled();
  });

  it("serves a key in its grace window and sends deprecation and sunset headers", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    const deprecatedAt = new Date(NOW - DAY);
    const { deps } = await makeDeps({ scopes: ["memory:write"], deprecatedAt });
    let header: Headers | undefined;

    await clientFor(deps).remember(
      { content: "x" },
      { headers: auth(), onHeader: (h) => (header = h) }
    );

    expect(header?.get("deprecation")).toBe(deprecatedAt.toUTCString());
    expect(header?.get("sunset")).toBe(new Date(NOW + 6 * DAY).toUTCString());
  });

  it("keeps the deprecation headers on a call a later check refuses", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    const deprecatedAt = new Date(NOW - DAY);
    const { deps } = await makeDeps({ scopes: ["memory:read"], deprecatedAt });
    let error: ConnectError | undefined;
    try {
      await clientFor(deps).remember({ content: "x" }, { headers: auth() });
    } catch (err) {
      error = ConnectError.from(err);
    }
    expect(error?.code).toBe(Code.PermissionDenied);
    expect(error?.metadata.get("deprecation")).toBe(deprecatedAt.toUTCString());
  });
});

describe("x-workspace-id metadata", () => {
  it("refuses a workspace other than the key's own, before any handler", async () => {
    const { deps, remember } = await makeDeps({ scopes: ["memory:write"] });
    const code = await codeOf(() =>
      CALLS["Remember"]!(clientFor(deps), auth({ "x-workspace-id": OTHER }))
    );
    expect(code).toBe(Code.InvalidArgument);
    expect(remember).not.toHaveBeenCalled();
  });

  it("accepts the key's own workspace", async () => {
    const { deps, remember } = await makeDeps({ scopes: ["memory:write"] });
    await clientFor(deps).remember({ content: "x" }, { headers: auth({ "x-workspace-id": WS }) });
    expect(remember).toHaveBeenCalledTimes(1);
    expect(remember.mock.calls[0]![0]).toMatchObject({ workspaceId: WS });
  });
});

describe("IP allowlist (moved into the shared evaluator)", () => {
  it("still denies a caller outside the key's allowlist", async () => {
    const { deps } = await makeDeps({ scopes: ["memory:write"], ipAllowlist: ["10.0.0.0/8"] });
    const code = await codeOf(() =>
      CALLS["Remember"]!(clientFor(deps), auth({ "x-forwarded-for": "192.168.1.1" }))
    );
    expect(code).toBe(Code.PermissionDenied);
  });

  it("still serves a caller inside it", async () => {
    const { deps, remember } = await makeDeps({
      scopes: ["memory:write"],
      ipAllowlist: ["10.0.0.0/8"],
    });
    await clientFor(deps).remember(
      { content: "x" },
      { headers: auth({ "x-forwarded-for": "10.1.2.3" }) }
    );
    expect(remember).toHaveBeenCalledTimes(1);
  });
});

describe("auth failure metrics", () => {
  it("counts gRPC failures under adapter grpc", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    const inc = vi.spyOn(authFailuresTotal, "inc");

    const { deps: bad } = await makeDeps({ scopes: ["memory:write"] });
    await codeOf(() => clientFor(bad).remember({ content: "x" }, { headers: {} }));
    expect(inc).toHaveBeenCalledWith({ adapter: "grpc", reason: "missing_token" });

    (bad.apiKeys.findByLookupHash as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await codeOf(() => CALLS["Remember"]!(clientFor(bad), auth()));
    expect(inc).toHaveBeenCalledWith({ adapter: "grpc", reason: "invalid_key" });

    const { deps: old } = await makeDeps({
      scopes: ["memory:write"],
      deprecatedAt: new Date(NOW - 8 * DAY),
    });
    await codeOf(() => CALLS["Remember"]!(clientFor(old), auth()));
    expect(inc).toHaveBeenCalledWith({ adapter: "grpc", reason: "deprecated_sunset" });

    const { deps: ok } = await makeDeps({ scopes: ["memory:write"] });
    await codeOf(() => CALLS["Remember"]!(clientFor(ok), auth({ "x-workspace-id": OTHER })));
    expect(inc).toHaveBeenCalledWith({ adapter: "grpc", reason: "workspace_switch_unsupported" });
  });
});
