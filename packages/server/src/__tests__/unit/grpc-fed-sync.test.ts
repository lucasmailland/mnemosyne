// packages/server/src/__tests__/unit/grpc-fed-sync.test.ts
import { describe, it, expect, vi } from "vitest";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { createMnemosyneRoutes, kAuth } from "../../grpc.js";
import { SyncMessageSchema } from "../../gen/mnemosyne_pb.js";

function fakeCtx() {
  const values = new Map<unknown, unknown>();
  values.set(kAuth, {
    workspaceId: "ws1",
    scopes: [],
    plan: "pro",
    actorId: "a1",
    ipAllowlist: [],
  });
  return { values: { get: (k: unknown) => values.get(k) } } as any;
}

// Capture what the router registers so we can call federationSync directly.
function captureRoutes(deps: any) {
  const impls: Record<string, any> = {};
  const router = {
    service(_svc: unknown, methods: Record<string, any>) {
      Object.assign(impls, methods);
    },
  } as any;
  createMnemosyneRoutes(router, deps);
  return impls;
}

async function* once(msg: any) {
  yield msg;
}

describe("gRPC FederationSync is refused (federation is pull-only)", () => {
  it("applies nothing and answers Unimplemented, even with federation wired", async () => {
    const processBatch = vi.fn();
    const deps = {
      federation: { syncEngine: { processBatch, forWorkspace: () => ({ processBatch }) } },
    } as any;
    const items = [
      { remoteId: "r1", version: 1, peerDomain: "peer.example", payload: { statement: "x" } },
    ];
    const inbound = create(SyncMessageSchema, {
      peerId: "peer1",
      delta: new TextEncoder().encode(JSON.stringify(items)),
      syncCursor: "c1",
      endOfBatch: true,
    });

    let caught: unknown;
    try {
      for await (const _ of captureRoutes(deps).federationSync(once(inbound), fakeCtx())) {
        /* drain */
      }
    } catch (err) {
      caught = err;
    }
    expect(ConnectError.from(caught).code).toBe(Code.Unimplemented);
    expect(String((caught as Error).message)).toMatch(/POST \/memory\/federation\/sync/);
    expect(processBatch).not.toHaveBeenCalled();
  });
});
