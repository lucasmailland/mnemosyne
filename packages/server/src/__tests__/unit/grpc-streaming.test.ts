import { describe, it, expect, vi } from "vitest";
import { createRouterTransport, createClient } from "@connectrpc/connect";
import bcrypt from "bcrypt";
import { MnemosyneService } from "../../gen/mnemosyne_pb.js";
import { createMnemosyneRoutes, createAuthInterceptor } from "../../grpc.js";
import type { ServerDeps } from "../../deps.js";

const WS = "00000000-0000-0000-0000-000000000001";
const TOKEN = "mns_live_abcdefghijklmnopqrstu";

function makeBus() {
  const subs: Array<{ glob: string; cb: (e: unknown) => void }> = [];
  return {
    subscribe(glob: string, cb: (e: unknown) => void) {
      const entry = { glob, cb };
      subs.push(entry);
      return () => {
        const i = subs.indexOf(entry);
        if (i >= 0) subs.splice(i, 1);
      };
    },
    emit(channel: string, e: unknown) {
      for (const s of subs) {
        if (
          s.glob === "*" ||
          (s.glob.endsWith(".*") && channel.startsWith(s.glob.slice(0, -2) + ".")) ||
          s.glob === channel
        ) {
          s.cb(e);
        }
      }
    },
    patternCount() {
      return subs.length;
    },
  };
}

async function authedClient(deps: Partial<ServerDeps>) {
  // Use cost=1 so bcrypt is ~1ms — avoids races where the emit timer fires
  // before the auth interceptor finishes and the bus subscription is set up.
  const apiKeys = {
    listActive: vi.fn().mockResolvedValue([]),
    findByLookupHash: vi.fn().mockResolvedValue({
      id: "k1",
      keyHash: await bcrypt.hash(TOKEN, 1),
      workspaceId: WS,
      scopes: ["memory:subscribe"],
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

describe("gRPC server-streaming — WatchMemory yields bus events", () => {
  it("pushes a bus event as a MemoryEvent", async () => {
    const bus = makeBus();
    const { client, headers } = await authedClient({ bus: bus as never });

    // Use AbortController so we can cleanly cancel the stream after receiving
    // the first event.  Relying on `break` alone does not abort ctx.signal in
    // the in-memory ConnectRPC transport.
    const ac = new AbortController();
    const received: string[] = [];

    // Emit after 50ms — well after the stream is listening (auth is ~1ms with cost=1).
    const emitTimer = setTimeout(() => {
      bus.emit("facts.created", {
        channel: "facts.created",
        type: "fact.created",
        payload: { id: "f1", workspaceId: WS },
        timestamp: new Date(), // determinism-ok: throwaway fixture date, not asserted
        traceId: "t1",
      });
    }, 50);

    try {
      const stream = client.watchMemory({ channels: ["facts.*"] }, { headers, signal: ac.signal });
      for await (const ev of stream) {
        received.push(ev.channel);
        // Cancel the stream after receiving the first event.
        ac.abort();
        break;
      }
    } catch (err: unknown) {
      // Aborting via AbortController throws ConnectError(Canceled) — expected.
      const isCanceled =
        err != null &&
        typeof err === "object" &&
        "code" in err &&
        (err as { code: unknown }).code === 1; /* Code.Canceled */
      const isAbort = err instanceof Error && err.name === "AbortError";
      if (!isCanceled && !isAbort) throw err;
    } finally {
      clearTimeout(emitTimer);
    }

    expect(received).toContain("facts.created");
  });
});

// S1 (re-audit 2026-11-22): the watch streams forwarded every bus event, from
// every workspace. They now apply ws.ts visibleEventFor: the caller's
// workspace only, nothing above its ceiling, and nothing that names no
// workspace. Each case emits the events that must be dropped first and a
// visible one last, so a leak shows up as the first event received.
const OTHER = "00000000-0000-0000-0000-000000000002";

async function firstReceived<T>(
  open: (signal: AbortSignal) => AsyncIterable<T>,
  emitAll: () => void
): Promise<T | undefined> {
  const ac = new AbortController();
  const timer = setTimeout(emitAll, 50);
  let first: T | undefined;
  try {
    for await (const ev of open(ac.signal)) {
      first = ev;
      ac.abort();
      break;
    }
  } catch (err: unknown) {
    const code = (err as { code?: unknown } | null)?.code;
    if (code !== 1 && !(err instanceof Error && err.name === "AbortError")) throw err;
  } finally {
    clearTimeout(timer);
  }
  return first;
}

const busEvent = (channel: string, payload: Record<string, unknown>) => ({
  channel,
  type: channel,
  payload,
  timestamp: new Date(), // determinism-ok: throwaway fixture date, not asserted
  traceId: "t",
});

describe("gRPC watch streams — workspace and ceiling isolation (S1)", () => {
  it("WatchMemory sends only the caller's workspace, under its ceiling", async () => {
    const bus = makeBus();
    const { client, headers } = await authedClient({ bus: bus as never });
    const first = await firstReceived(
      (signal) => client.watchMemory({ channels: ["facts.*"] }, { headers, signal }),
      () => {
        bus.emit("facts.other", busEvent("facts.other", { id: "x", workspaceId: OTHER }));
        bus.emit("facts.nows", busEvent("facts.nows", { id: "y" }));
        bus.emit(
          "facts.secret",
          busEvent("facts.secret", { id: "z", workspaceId: WS, sensitivity: "confidential" })
        );
        bus.emit("facts.mine", busEvent("facts.mine", { id: "f", workspaceId: WS }));
      }
    );
    expect(first?.channel).toBe("facts.mine");
  });

  it("WatchTasks sends only the caller's workspace", async () => {
    const bus = makeBus();
    const { client, headers } = await authedClient({ bus: bus as never });
    const first = await firstReceived(
      (signal) => client.watchTasks({}, { headers, signal }),
      () => {
        bus.emit(
          "tasks.updated",
          busEvent("tasks.updated", { taskId: "other", workspaceId: OTHER })
        );
        bus.emit("tasks.updated", busEvent("tasks.updated", { taskId: "nows" }));
        bus.emit("tasks.updated", busEvent("tasks.updated", { taskId: "mine", workspaceId: WS }));
      }
    );
    expect(first?.taskId).toBe("mine");
  });
});
