/**
 * gRPC IngestBatch actor provenance (P51).
 *
 * Before this change, `ingestBatch` had zero test coverage — provenance was
 * never wired into any of its `createFact` calls. This is the first-ever
 * functional test for the RPC, added alongside the P51 provenance fix.
 *
 * `resolveGrpcProvenance` is a private (unexported) helper in `grpc.ts`, so
 * "called exactly once per RPC, not once per streamed item" can't be proven
 * by spying on it directly. Instead we spy on `formatActorRef` — the only
 * side-effecting-ish call `resolveGrpcProvenance` makes — via a partial mock
 * of `@mnemo-ai/types`. If the resolve were (incorrectly) placed inside the
 * `for await` loop, `formatActorRef` would be called 3 times instead of 1.
 */
import { describe, it, expect, vi } from "vitest";
import bcrypt from "bcrypt";
import { createRouterTransport, createClient } from "@connectrpc/connect";
import { MnemosyneService } from "../../gen/mnemosyne_pb.js";
import { createMnemosyneRoutes, createAuthInterceptor } from "../../grpc.js";
import type { ServerDeps } from "../../deps.js";
import { makeMockCognitive } from "../helpers/mockCognitive.js";
import * as mnemoTypes from "@mnemo-ai/types";

vi.mock("@mnemo-ai/types", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mnemo-ai/types")>();
  return {
    ...actual,
    formatActorRef: vi.fn(actual.formatActorRef),
  };
});

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

describe("gRPC IngestBatch (P51 actor provenance)", () => {
  it("streams 3 items, persists 2, rejects 1, and stamps the same resolved provenance on every remember call", async () => {
    const remember = vi
      .fn()
      .mockResolvedValueOnce({ id: "f1", kind: "fact", staged: false, vectorSearchable: true })
      .mockResolvedValueOnce({ id: "f2", kind: "fact", staged: false, vectorSearchable: true })
      .mockRejectedValueOnce(new Error("boom"));
    const cognitive = makeMockCognitive({ remember });
    const { client, headers } = await authedClient({ cognitive });

    async function* items() {
      yield { content: "fact one", type: "fact", topicKey: "" };
      yield { content: "fact two", type: "fact", topicKey: "" };
      yield { content: "fact three", type: "fact", topicKey: "" };
    }

    const result = await client.ingestBatch(items(), { headers });

    expect(result.accepted).toBe(2);
    expect(result.rejected).toBe(1);
    expect(remember).toHaveBeenCalledTimes(3);
    for (let i = 0; i < 3; i++) {
      const [arg, auth] = remember.mock.calls[i]!;
      expect(arg.workspaceId).toBe(WS);
      expect(auth.actorId).toBe("key:k1");
      expect(auth.userId).toBeNull();
      expect(auth.actorType).toBe("user");
    }
    // Proves resolveGrpcProvenance() ran exactly once for the whole RPC, not
    // once per streamed item.
    expect(mnemoTypes.formatActorRef).toHaveBeenCalledTimes(1);
  });
});
