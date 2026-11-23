import { describe, expect, it } from "vitest";

import { pinClientIpHeaders, readGrpcPort } from "../../boot/grpc-port.js";

describe("readGrpcPort (MNEMO_GRPC_PORT)", () => {
  it("is off when unset or empty, so the server keeps one HTTP/1.1 listener", () => {
    expect(readGrpcPort({}, 3000)).toBeUndefined();
    expect(readGrpcPort({ MNEMO_GRPC_PORT: "  " }, 3000)).toBeUndefined();
  });

  it("reads a valid port", () => {
    expect(readGrpcPort({ MNEMO_GRPC_PORT: "50051" }, 3000)).toBe(50051);
  });

  it.each(["0", "65536", "-1", "50051x", "5e4", "abc"])("refuses %s", (raw) => {
    expect(() => readGrpcPort({ MNEMO_GRPC_PORT: raw }, 3000)).toThrow(/MNEMO_GRPC_PORT/);
  });

  it("refuses the HTTP/1.1 port", () => {
    expect(() => readGrpcPort({ MNEMO_GRPC_PORT: "3000" }, 3000)).toThrow(/differ from PORT/);
  });
});

describe("pinClientIpHeaders", () => {
  const req = (remoteAddress: string) => ({
    headers: {
      "x-forwarded-for": "203.0.113.7",
      "cf-connecting-ip": "203.0.113.7",
      "x-real-ip": "203.0.113.7",
    } as Record<string, string | string[] | undefined>,
    socket: { remoteAddress },
  });

  it("replaces client-written IP headers with the socket address", () => {
    const r = req("::ffff:198.51.100.20");
    pinClientIpHeaders(r, undefined);
    expect(r.headers).toEqual({ "x-forwarded-for": "198.51.100.20" });
  });

  it("does the same when the connection is not from the trusted proxy", () => {
    const r = req("198.51.100.20");
    pinClientIpHeaders(r, "10.0.0.5");
    expect(r.headers["x-forwarded-for"]).toBe("198.51.100.20");
    expect(r.headers["cf-connecting-ip"]).toBeUndefined();
  });

  it("keeps the headers from the trusted proxy", () => {
    const r = req("::ffff:10.0.0.5");
    pinClientIpHeaders(r, "10.0.0.5");
    expect(r.headers["x-forwarded-for"]).toBe("203.0.113.7");
    expect(r.headers["cf-connecting-ip"]).toBe("203.0.113.7");
  });
});
