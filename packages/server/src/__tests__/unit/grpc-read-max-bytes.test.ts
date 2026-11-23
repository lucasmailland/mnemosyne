/**
 * AUTH-GRPC-PARITY G4 — the Connect adapter caps each message at 1 MiB.
 *
 * Connect reads a unary request body into memory before any interceptor runs,
 * and its default cap is ~4 GiB, so an unauthenticated caller could make the
 * server buffer gigabytes. HTTP caps /v1 bodies at 1 MiB before auth
 * (app.ts BODY_LIMIT_BYTES); the gRPC cap is the same value, so a payload that
 * is legal over HTTP is legal over gRPC.
 *
 * These tests run the real connectNodeAdapter on an in-process node:http
 * server: createRouterTransport (the other gRPC suites) skips the adapter, and
 * the cap lives in the adapter.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Code, ConnectError, createClient, type Transport } from "@connectrpc/connect";
import { createConnectTransport, createGrpcWebTransport } from "@connectrpc/connect-node";
import bcrypt from "bcrypt";
import { MnemosyneService } from "../../gen/mnemosyne_pb.js";
import { createConnectHandler } from "../../grpc.js";
import type { ServerDeps } from "../../deps.js";
import { makeMockCognitive } from "../helpers/mockCognitive.js";

const WS = "00000000-0000-0000-0000-000000000001";
const TOKEN = "mns_live_abcdefghijklmnopqrstu";
const CAP = 1024 * 1024;
const headers = { authorization: `Bearer ${TOKEN}` };

let server: Server;
let baseUrl: string;
let apiKeys: {
  listActive: ReturnType<typeof vi.fn>;
  findByLookupHash: ReturnType<typeof vi.fn>;
  touch: ReturnType<typeof vi.fn>;
};
let remember: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  // A valid key: had the oversized call reached the interceptor, it would pass.
  apiKeys = {
    listActive: vi.fn().mockResolvedValue([]),
    findByLookupHash: vi.fn().mockResolvedValue({
      id: "k1",
      keyHash: await bcrypt.hash(TOKEN, 1),
      workspaceId: WS,
      scopes: ["memory:read", "memory:write"],
    }),
    touch: vi.fn(),
  };
  remember = vi.fn().mockResolvedValue({ id: "f1", kind: "fact", staged: false });
  const deps = { apiKeys, cognitive: makeMockCognitive({ remember }) } as unknown as ServerDeps;
  const handler = createConnectHandler(deps);
  server = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const transports: Array<[string, () => Transport]> = [
  ["Connect", () => createConnectTransport({ baseUrl, httpVersion: "1.1" })],
  ["gRPC-web", () => createGrpcWebTransport({ baseUrl, httpVersion: "1.1" })],
];

async function codeOf(call: Promise<unknown>): Promise<Code | "ok"> {
  try {
    await call;
    return "ok";
  } catch (err) {
    return ConnectError.from(err).code;
  }
}

describe.each(transports)("gRPC message cap over %s", (_name, transport) => {
  it("rejects a unary message over 1 MiB before the key lookup", async () => {
    const client = createClient(MnemosyneService, transport());

    const code = await codeOf(client.remember({ content: "x".repeat(CAP + 1) }, { headers }));

    expect(code).toBe(Code.ResourceExhausted);
    expect(apiKeys.findByLookupHash).not.toHaveBeenCalled();
    expect(apiKeys.listActive).not.toHaveBeenCalled();
    expect(remember).not.toHaveBeenCalled();
  });

  it("still serves a unary message under the cap", async () => {
    const client = createClient(MnemosyneService, transport());

    await client.remember({ content: "x".repeat(CAP / 2) }, { headers });

    expect(remember).toHaveBeenCalledTimes(1);
  });

  it("rejects a streamed message over 1 MiB, persisting nothing", async () => {
    const client = createClient(MnemosyneService, transport());
    async function* chunks() {
      yield { data: new Uint8Array(CAP + 1) };
    }

    const code = await codeOf(client.importMemory(chunks(), { headers }));

    expect(code).toBe(Code.ResourceExhausted);
    expect(remember).not.toHaveBeenCalled();
  });

  it("still imports a stream larger than 1 MiB sent in chunks under the cap", async () => {
    const client = createClient(MnemosyneService, transport());
    // Each fact line is ~100 KiB, so the whole file is ~1.5 MiB. Each chunk
    // stays under the cap with room for the message's own framing bytes.
    const lines = [JSON.stringify({ version: "mnemo-export-v1", workspaceId: WS })];
    for (let i = 0; i < 15; i++) {
      lines.push(JSON.stringify({ _type: "fact", statement: `${i} ${"y".repeat(100 * 1024)}` }));
    }
    const file = Buffer.from(lines.join("\n"), "utf8");
    expect(file.length).toBeGreaterThan(CAP);
    const chunkSize = CAP - 1024;
    async function* chunks() {
      for (let at = 0; at < file.length; at += chunkSize) {
        yield { data: new Uint8Array(file.subarray(at, at + chunkSize)) };
      }
    }

    const result = await client.importMemory(chunks(), { headers });

    expect(result.imported).toBe(15);
    expect(remember).toHaveBeenCalledTimes(15);
  });
});
