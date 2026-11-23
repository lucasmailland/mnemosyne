import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({
  postgres: vi.fn(),
  sockets: [] as Array<{
    destroyed: boolean;
    connect: ReturnType<typeof vi.fn>;
    emit: (event: string, ...args: unknown[]) => boolean;
  }>,
  end: vi.fn(),
  socketReady: Promise.resolve() as Promise<unknown>,
  host: ["127.0.0.1"],
  port: [5432],
  answerQuery: false,
}));

vi.mock("node:net", () => ({
  Socket: class extends EventEmitter {
    destroyed = false;
    connect = vi.fn(() => this);
    constructor() {
      super();
      transport.sockets.push(this);
    }
    destroy(error?: Error) {
      this.destroyed = true;
      if (error) this.emit("error", error);
      this.emit("close");
      return this;
    }
  },
}));

vi.mock("postgres", () => ({ default: transport.postgres }));

import { createDirectPgProbe } from "../../resilience/poolStallWatchdog.js";

beforeEach(() => {
  vi.clearAllMocks();
  transport.sockets.length = 0;
  transport.host = ["127.0.0.1"];
  transport.port = [5432];
  transport.answerQuery = false;
  transport.postgres.mockImplementation((_url, options) => {
    let rejectQuery: (error: Error) => void;
    let resolveQuery: () => void;
    const query = new Promise<void>((resolve, reject) => {
      resolveQuery = resolve;
      rejectQuery = reject;
    });
    const sql = () => {
      // postgres.js end({timeout: 0}) does not forcibly destroy its socket
      // during connection startup. Keep the fake driver's graceful end equally
      // independent of transport destruction, so the probe must own cleanup.
      transport.socketReady = options.socket?.({ host: transport.host, port: transport.port });
      Promise.resolve(transport.socketReady).then(() => {
        if (transport.answerQuery) resolveQuery();
      }, rejectQuery);
      return query;
    };
    transport.end.mockImplementation(async () => {
      rejectQuery(new Error("client ended"));
    });
    return Object.assign(sql, { end: transport.end });
  });
});

describe("direct probe owns its transport across abort races", () => {
  it("tries the healthy fallback after the first endpoint refuses startup", async () => {
    transport.host = ["refused", "healthy"];
    transport.port = [5432, 5433];
    transport.answerQuery = true;
    const result = createDirectPgProbe("postgres://fixture/fixture")(
      new AbortController().signal
    ).catch((error) => error);
    await vi.waitFor(() => expect(transport.sockets).toHaveLength(1));
    transport.sockets[0].emit("error", new Error("ECONNREFUSED"));
    await vi.waitFor(() => expect(transport.sockets).toHaveLength(2));
    expect(transport.sockets[1].connect).toHaveBeenCalledWith({ host: "healthy", port: 5433 });
    transport.sockets[1].emit("connect");
    expect(await result).toBeUndefined();
    expect(transport.sockets.every((socket) => socket.destroyed)).toBe(true);
  });

  it("exhausts each endpoint once and closes every failed socket", async () => {
    transport.host = ["first", "second"];
    transport.port = [5432, 5433];
    const result = createDirectPgProbe("postgres://fixture/fixture")(
      new AbortController().signal
    ).catch((error) => error);
    await vi.waitFor(() => expect(transport.sockets).toHaveLength(1));
    transport.sockets[0].emit("error", new Error("first refused"));
    await vi.waitFor(() => expect(transport.sockets).toHaveLength(2));
    transport.sockets[1].emit("error", new Error("second refused"));
    expect(await result).toMatchObject({ message: "second refused" });
    expect(transport.sockets.every((socket) => socket.destroyed)).toBe(true);
  });

  it("aborts during failover without attempting a further endpoint", async () => {
    transport.host = ["first", "second", "third"];
    transport.port = [5432, 5433, 5434];
    const controller = new AbortController();
    const result = createDirectPgProbe("postgres://fixture/fixture")(controller.signal).catch(
      (error) => error
    );
    await vi.waitFor(() => expect(transport.sockets).toHaveLength(1));
    transport.sockets[0].emit("error", new Error("first refused"));
    await vi.waitFor(() => expect(transport.sockets).toHaveLength(2));
    controller.abort();
    expect(await result).toBeInstanceOf(Error);
    expect(transport.sockets).toHaveLength(2);
    expect(transport.sockets.every((socket) => socket.destroyed)).toBe(true);
  });

  it("destroys a socket still connecting when the deadline aborts", async () => {
    const controller = new AbortController();
    const probe = createDirectPgProbe("postgres://fixture/fixture")(controller.signal);
    const result = probe.catch((error) => error);
    await vi.waitFor(() => expect(transport.sockets).toHaveLength(1));
    expect(transport.sockets[0].destroyed).toBe(false);
    controller.abort();
    expect(await result).toBeInstanceOf(Error);
    expect(transport.sockets[0].destroyed).toBe(true);
    expect(transport.end).toHaveBeenCalled();
  });

  it("destroys a connected socket when the database never answers", async () => {
    const controller = new AbortController();
    const result = createDirectPgProbe("postgres://fixture/fixture")(controller.signal).catch(
      (error) => error
    );
    await vi.waitFor(() => expect(transport.sockets).toHaveLength(1));
    transport.sockets[0].emit("connect");
    await transport.socketReady;
    controller.abort();
    expect(await result).toBeInstanceOf(Error);
    expect(transport.sockets[0].destroyed).toBe(true);
  });

  it("creates neither a client nor a socket for an already-aborted probe", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      createDirectPgProbe("postgres://fixture/fixture")(controller.signal)
    ).rejects.toThrow("aborted");
    expect(transport.postgres).not.toHaveBeenCalled();
    expect(transport.sockets).toHaveLength(0);
  });
});
