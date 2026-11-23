/**
 * gRPC Session bidi + ImportMemory persistence (deep re-audit P1-1).
 *
 * Before: Session returned "Session bidi pending Wave N wiring" for every
 * inbound frame; ImportMemory drained the stream and persisted nothing.
 * After: Session drives startSession/appendTurn/collapseSession over the core,
 * and ImportMemory reassembles the byte stream → gzip JSONL → core.createFact.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { gzipSync } from "node:zlib";
import { Code, ConnectError, createRouterTransport, createClient } from "@connectrpc/connect";
import bcrypt from "bcrypt";
import { MnemosyneService } from "../../gen/mnemosyne_pb.js";
import { createMnemosyneRoutes, createAuthInterceptor } from "../../grpc.js";
import type { ServerDeps } from "../../deps.js";
import { makeMockCognitive } from "../helpers/mockCognitive.js";

const WS = "00000000-0000-0000-0000-000000000001";
const TOKEN = "mns_live_abcdefghijklmnopqrstu";

async function authedClient(deps: Partial<ServerDeps>) {
  const apiKeys = {
    listActive: vi.fn().mockResolvedValue([]),
    findByLookupHash: vi.fn().mockResolvedValue({
      id: "k1",
      keyHash: await bcrypt.hash(TOKEN, 1),
      workspaceId: WS,
      scopes: ["memory:write"],
    }),
    touch: vi.fn(),
  };
  const full = { apiKeys, ...deps } as unknown as ServerDeps;
  const transport = createRouterTransport((r) => createMnemosyneRoutes(r, full), {
    router: { interceptors: [createAuthInterceptor(full)] },
  });
  const client = createClient(MnemosyneService, transport);
  return { client, headers: { authorization: `Bearer ${TOKEN}` } };
}

describe("gRPC Session bidi (P1-1)", () => {
  it("starts a session, appends a turn, and collapses — driving deps.storage/deps.cognitive", async () => {
    const createSession = vi.fn().mockResolvedValue({
      id: "sess-1",
      workspaceId: WS,
      agentId: "agentA",
      status: "active",
      openedAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
      collapsedAt: null,
      metadata: {},
    });
    const listTurns = vi.fn().mockResolvedValue([]);
    const appendTurn = vi.fn().mockResolvedValue(undefined);
    const collapseSession = vi
      .fn()
      .mockResolvedValue({ turnsProcessed: 1, anticipationAccuracy: null });
    const storage = { createSession, listTurns, appendTurn } as unknown as ServerDeps["storage"];
    const cognitive = makeMockCognitive({ collapseSession });

    const { client, headers } = await authedClient({ storage, cognitive });

    async function* frames() {
      yield { payload: { case: "controlFrame" as const, value: 'start {"agentId":"agentA"}' } };
      yield { payload: { case: "userTurn" as const, value: "hello world" } };
      yield { payload: { case: "controlFrame" as const, value: "collapse" } };
    }

    const responses: string[] = [];
    for await (const resp of client.session(frames(), { headers })) {
      if (resp.payload.case === "assistantTurn") responses.push(resp.payload.value);
      if (resp.payload.case === "error")
        throw new Error(`unexpected error frame: ${resp.payload.value.message}`);
    }

    expect(createSession).toHaveBeenCalledTimes(1);
    expect(createSession.mock.calls[0]![0]).toMatchObject({ workspaceId: WS, agentId: "agentA" });
    expect(listTurns).toHaveBeenCalledWith("sess-1", WS);
    expect(appendTurn).toHaveBeenCalledTimes(1);
    expect(appendTurn.mock.calls[0]![0]).toBe("sess-1");
    expect(appendTurn.mock.calls[0]![1]).toMatchObject({
      sessionId: "sess-1",
      turnIndex: 0,
      role: "user",
      content: "hello world",
    });
    expect(collapseSession).toHaveBeenCalledTimes(1);
    expect(collapseSession.mock.calls[0]![0]).toMatchObject({
      sessionId: "sess-1",
      workspaceId: WS,
    });
    expect(responses).toEqual(["started:sess-1", "ack:11", "collapsed:sess-1"]);
  });

  it("emits a SessionError frame (not a throw) when a turn fails", async () => {
    const storage = {
      createSession: vi.fn().mockResolvedValue({
        id: "s2",
        workspaceId: WS,
        agentId: null,
        status: "active",
        openedAt: new Date(), // determinism-ok: fixture timestamp, not asserted
        collapsedAt: null,
        metadata: {},
      }),
      listTurns: vi.fn().mockResolvedValue([]),
      appendTurn: vi.fn().mockRejectedValue(new Error("turn boom")),
    } as unknown as ServerDeps["storage"];
    const { client, headers } = await authedClient({ storage, cognitive: makeMockCognitive() });

    async function* frames() {
      yield { payload: { case: "userTurn" as const, value: "x" } };
    }

    let errorMessage: string | null = null;
    for await (const resp of client.session(frames(), { headers })) {
      if (resp.payload.case === "error") errorMessage = resp.payload.value.message;
    }
    expect(errorMessage).toBe("turn boom");
  });
});

describe("gRPC ImportMemory (P1-1)", () => {
  it("reassembles the byte stream, parses gzip JSONL, and persists facts", async () => {
    const remember = vi
      .fn()
      .mockResolvedValue({ id: "f1", kind: "fact", staged: false, vectorSearchable: true });
    const cognitive = makeMockCognitive({ remember });
    const { client, headers } = await authedClient({ cognitive });

    const header = JSON.stringify({ version: "mnemo-export-v1", workspaceId: WS });
    const factA = JSON.stringify({ _type: "fact", statement: "the sky is blue", tags: ["color"] });
    const factB = JSON.stringify({ _type: "fact", statement: "grass is green" });
    const nonFact = JSON.stringify({ _type: "task", title: "ignored" });
    const jsonl = [header, factA, factB, nonFact].join("\n");
    const gz = gzipSync(Buffer.from(jsonl, "utf8"));

    // Split the gzip buffer into 2 chunks to exercise reassembly.
    const mid = Math.floor(gz.length / 2);
    async function* chunks() {
      yield { data: new Uint8Array(gz.subarray(0, mid)) };
      yield { data: new Uint8Array(gz.subarray(mid)) };
    }

    const result = await client.importMemory(chunks(), { headers });
    expect(result.imported).toBe(2);
    expect(result.skipped).toBe(1); // the non-fact line
    expect(remember).toHaveBeenCalledTimes(2);
    const [arg0, auth0] = remember.mock.calls[0]!;
    expect(arg0.workspaceId).toBe(WS);
    expect(arg0.content).toBe("the sky is blue");
    expect(arg0.tags).toEqual(["color"]);
    expect(auth0.actorId).toBe("key:k1");
    expect(auth0.userId).toBeNull();
    expect(auth0.actorType).toBe("user");
    const [arg1, auth1] = remember.mock.calls[1]!;
    expect(arg1.workspaceId).toBe(WS);
    expect(arg1.content).toBe("grass is green");
    expect(auth1.actorId).toBe("key:k1");
    expect(auth1.userId).toBeNull();
    expect(auth1.actorType).toBe("user");
  });

  it("returns imported:0 for an empty stream", async () => {
    const remember = vi.fn();
    const cognitive = makeMockCognitive({ remember });
    const { client, headers } = await authedClient({ cognitive });

    async function* chunks(): AsyncGenerator<{ data: Uint8Array }> {
      // no chunks
    }
    const result = await client.importMemory(chunks(), { headers });
    expect(result.imported).toBe(0);
    expect(remember).not.toHaveBeenCalled();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // APP-028 parity (re-audit 2026-11-22): HTTP /import inflates with a ceiling
  // (MNEMO_IMPORT_MAX_DECOMPRESSED_BYTES); ImportMemory gunzipped without one,
  // so a small gzip bomb inflated without bound on the event loop.
  it("refuses a stream that inflates past MNEMO_IMPORT_MAX_DECOMPRESSED_BYTES", async () => {
    vi.stubEnv("MNEMO_IMPORT_MAX_DECOMPRESSED_BYTES", "4096");
    const remember = vi.fn();
    const { client, headers } = await authedClient({ cognitive: makeMockCognitive({ remember }) });
    const line = JSON.stringify({ _type: "fact", statement: "x".repeat(200) });
    const bomb = gzipSync(Buffer.from(Array(200).fill(line).join("\n"), "utf8"));
    expect(bomb.length).toBeLessThan(4096);
    async function* chunks() {
      yield { data: new Uint8Array(bomb) };
    }
    const err = await client.importMemory(chunks(), { headers }).then(
      () => null,
      (e: unknown) => ConnectError.from(e)
    );
    expect(err?.code).toBe(Code.ResourceExhausted);
    expect(remember).not.toHaveBeenCalled();
  });
});
