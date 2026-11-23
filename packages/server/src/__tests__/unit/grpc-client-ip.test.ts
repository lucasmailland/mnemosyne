/**
 * APP-027 residual (re-audit 2026-11-22): the gRPC IP allowlist believed
 * CF-Connecting-IP or the leftmost X-Forwarded-For of any request, so a stolen
 * IP-restricted key worked from anywhere by writing the header itself. It now
 * reads the client as HTTP does (client-ip.ts clientIpOf): the socket peer is
 * the truth, forwarding headers count only from a trusted proxy, and a
 * single-address header only when named in MNEMO_TRUSTED_PROXY_HEADER.
 *
 * Runs the real connectNodeAdapter on 127.0.0.1: the peer address only exists
 * there (createRouterTransport has no socket).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import bcrypt from "bcrypt";
import { MnemosyneService } from "../../gen/mnemosyne_pb.js";
import { createConnectHandler } from "../../grpc.js";
import type { ServerDeps } from "../../deps.js";
import { makeMockCognitive } from "../helpers/mockCognitive.js";

const WS = "00000000-0000-0000-0000-000000000001";
const TOKEN = "mns_live_abcdefghijklmnopqrstu";
const ALLOWED = "203.0.113.7";

let server: Server;
let baseUrl: string;

beforeEach(async () => {
  const apiKeys = {
    listActive: vi.fn().mockResolvedValue([]),
    findByLookupHash: vi.fn().mockResolvedValue({
      id: "k1",
      keyHash: await bcrypt.hash(TOKEN, 1),
      workspaceId: WS,
      scopes: ["memory:write"],
      ipAllowlist: [ALLOWED],
    }),
    touch: vi.fn(),
  };
  const remember = vi.fn().mockResolvedValue({ id: "f1", kind: "fact", staged: false });
  const deps = { apiKeys, cognitive: makeMockCognitive({ remember }) } as unknown as ServerDeps;
  const handler = createConnectHandler(deps);
  server = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function codeWith(headers: Record<string, string>): Promise<Code | "ok"> {
  const client = createClient(
    MnemosyneService,
    createConnectTransport({ baseUrl, httpVersion: "1.1" })
  );
  try {
    await client.remember(
      { content: "x" },
      { headers: { authorization: `Bearer ${TOKEN}`, ...headers } }
    );
    return "ok";
  } catch (err) {
    return ConnectError.from(err).code;
  }
}

describe("gRPC IP allowlist reads the client as HTTP does", () => {
  it("ignores an allowlisted address claimed by a peer that is not a proxy", async () => {
    // 127.0.0.1 is not the named proxy, so it is the client itself.
    vi.stubEnv("MNEMO_TRUSTED_PROXY_IP", "10.9.9.9");
    expect(await codeWith({ "x-forwarded-for": ALLOWED })).toBe(Code.PermissionDenied);
    expect(await codeWith({ "cf-connecting-ip": ALLOWED })).toBe(Code.PermissionDenied);
    expect(await codeWith({ "x-real-ip": ALLOWED })).toBe(Code.PermissionDenied);
  });

  it("believes X-Forwarded-For from the trusted proxy, rightmost hop first", async () => {
    vi.stubEnv("MNEMO_TRUSTED_PROXY_IP", "127.0.0.1");
    expect(await codeWith({ "x-forwarded-for": ALLOWED })).toBe("ok");
    // The leftmost entry is the client's own claim; the proxy appended the real one.
    expect(await codeWith({ "x-forwarded-for": `${ALLOWED}, 198.51.100.9` })).toBe(
      Code.PermissionDenied
    );
  });

  it("believes a single-address header from the proxy only when it is named", async () => {
    vi.stubEnv("MNEMO_TRUSTED_PROXY_IP", "127.0.0.1");
    expect(await codeWith({ "cf-connecting-ip": ALLOWED })).toBe(Code.PermissionDenied);
    vi.stubEnv("MNEMO_TRUSTED_PROXY_HEADER", "cf-connecting-ip");
    expect(await codeWith({ "cf-connecting-ip": ALLOWED })).toBe("ok");
  });
});
