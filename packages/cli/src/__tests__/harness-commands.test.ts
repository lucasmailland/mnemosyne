import { describe, expect, it, vi } from "vitest";
import { HARNESS_HELP, runHarnessCommand, type HarnessCommandDeps } from "../harness-commands.js";

const SECRET = "SECRET-MESSAGE-CONTENT";

function deps(overrides: Partial<HarnessCommandDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const base: HarnessCommandDeps = {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    confirm: vi.fn(async () => true),
    diagnose: vi.fn(async () => ({
      ok: true,
      queue: { count: 0, bytes: 0, oldestAgeSeconds: null, deadLetters: 0 },
      delivery: { attempt: 0, nextAttemptAt: null, blocked: null },
      binding: {
        bound: true,
        serverUrl: "https://s",
        workspaceId: "w",
        installationId: "i",
        keyFingerprint: "f",
      },
      filesystem: { mode: "available", reasons: [] },
      capture: { fullFidelity: true },
      selfTest: { ran: false, ok: false },
      problems: [],
    })),
    listQueue: vi.fn(async () => ({
      pending: [
        {
          eventId: "e1",
          type: "turn.append",
          enqueueSequence: 1,
          bytes: 120,
          occurredAt: "2026-09-10T00:00:00.000Z",
          content: SECRET,
        },
      ],
      quarantined: [{ id: "q1", bytes: 300 }],
    })),
    releaseRetry: vi.fn(async () => ({ released: 1, bindingChanged: false })),
    discardQueue: vi.fn(async () => ({ discarded: 2 })),
    probe: vi.fn(async () => ({ available: true, workspaceId: "w", persisted: false })),
    captureHook: vi.fn(async () => ({ durable: true })),
    ...overrides,
  };
  return { deps: base, out, err };
}

const run = (argv: string[], d: HarnessCommandDeps) => runHarnessCommand(argv, d);

describe("mnemo harness queue", () => {
  it("lists pending and quarantined records without ever printing content", async () => {
    const { deps: d, out } = deps();

    expect(await run(["queue", "list"], d)).toBe(0);

    const printed = out.join("\n");
    expect(printed).toContain("e1");
    expect(printed).toContain("q1");
    // The queue holds conversations. Listing it must never spill one to a terminal.
    expect(printed).not.toContain(SECRET);
  });

  it("reports an empty queue rather than printing nothing at all", async () => {
    const { deps: d, out } = deps({
      listQueue: vi.fn(async () => ({ pending: [], quarantined: [] })),
    });

    expect(await run(["queue", "list"], d)).toBe(0);
    expect(out.join("\n")).toMatch(/empty|0 pending/i);
  });
});

describe("mnemo harness retry", () => {
  it("releases a blocked queue without touching the binding", async () => {
    const { deps: d, out } = deps();

    expect(await run(["retry"], d)).toBe(0);

    expect(d.releaseRetry).toHaveBeenCalled();
    expect(out.join("\n")).toContain("1");
  });

  it("refuses when releasing would change what the queue is bound to", async () => {
    const { deps: d, err } = deps({
      releaseRetry: vi.fn(async () => ({ released: 0, bindingChanged: true })),
    });

    // Retrying must never quietly redirect queued conversations somewhere else.
    expect(await run(["retry"], d)).not.toBe(0);
    expect(err.join("\n")).toMatch(/binding/i);
  });
});

describe("mnemo harness discard", () => {
  it("requires a reason", async () => {
    const { deps: d, err } = deps();

    expect(await run(["discard"], d)).not.toBe(0);
    expect(d.discardQueue).not.toHaveBeenCalled();
    expect(err.join("\n")).toMatch(/reason/i);
  });

  it("asks before destroying anything", async () => {
    const confirm = vi.fn(async () => false);
    const { deps: d } = deps({ confirm });

    expect(await run(["discard", "--reason", "stale queue"], d)).not.toBe(0);
    expect(confirm).toHaveBeenCalled();
    expect(d.discardQueue).not.toHaveBeenCalled();
  });

  it("skips the prompt with --yes, for scripted operators", async () => {
    const confirm = vi.fn(async () => true);
    const { deps: d } = deps({ confirm });

    expect(await run(["discard", "--reason", "stale queue", "--yes"], d)).toBe(0);
    expect(confirm).not.toHaveBeenCalled();
    expect(d.discardQueue).toHaveBeenCalledWith(expect.objectContaining({ reason: "stale queue" }));
  });

  it("never prints what it discarded", async () => {
    const { deps: d, out } = deps({
      discardQueue: vi.fn(async () => ({ discarded: 1 })),
    });

    await run(["discard", "--reason", "stale queue", "--yes"], d);
    expect(out.join("\n")).not.toContain(SECRET);
  });
});

describe("mnemo harness doctor", () => {
  it("reports a healthy local harness and exits zero", async () => {
    const { deps: d, out } = deps();

    expect(await run(["doctor"], d)).toBe(0);
    expect(out.join("\n")).toMatch(/ok|healthy/i);
  });

  for (const [label, report] of [
    ["unsafe filesystem", { filesystem: { mode: "unavailable", reasons: ["no_flock"] } }],
    [
      "an operator block",
      { delivery: { attempt: 3, nextAttemptAt: null, blocked: { status: 401, at: "x" } } },
    ],
    ["no binding", { binding: { bound: false } }],
  ] as const) {
    it(`exits non-zero on ${label}`, async () => {
      const { deps: base } = deps();
      const d: HarnessCommandDeps = {
        ...base,
        diagnose: vi.fn(async () => ({
          ...(await base.diagnose()),
          ...report,
          ok: false,
          problems: ["something"],
        })) as never,
      };

      // An operator command must fail loudly; this is what a script checks.
      expect(await run(["doctor"], d)).not.toBe(0);
    });
  }
});

describe("mnemo harness doctor, per host (APP-034d)", () => {
  it("prints each host's effective capture mode and why", async () => {
    const { deps: base, out } = deps();
    const d: HarnessCommandDeps = {
      ...base,
      diagnose: vi.fn(async () => ({
        ...(await base.diagnose()),
        hosts: [
          {
            host: "claude-code",
            consented: "user-only",
            mode: "user-only",
            reason: "consented to user-only",
          },
          {
            host: "codex",
            consented: "user-only",
            mode: "mcp-only",
            reason: "qualification: qualification is for host version 0.163.0, this is 0.169.0",
          },
        ],
      })) as never,
    };
    await run(["doctor"], d);
    const printed = out.join("\n");
    expect(printed).toMatch(/claude-code.*user-only.*consented to user-only/);
    expect(printed).toMatch(/codex.*mcp-only.*0\.169\.0/);
  });
});

describe("mnemo harness probe", () => {
  it("checks the server without writing anything", async () => {
    const { deps: d, out } = deps();

    expect(await run(["probe"], d)).toBe(0);
    expect(d.probe).toHaveBeenCalled();
    expect(out.join("\n")).toMatch(/available/i);
  });

  it("fails when the server refuses the probe", async () => {
    const { deps: d } = deps({
      probe: vi.fn(async () => ({ available: false, workspaceId: "w", persisted: false })),
    });
    expect(await run(["probe"], d)).not.toBe(0);
  });

  it("fails loudly if a probe ever persisted state", async () => {
    const { deps: d, err } = deps({
      probe: vi.fn(async () => ({ available: true, workspaceId: "w", persisted: true })),
    });

    // A probe is a read. If it wrote, the contract is broken and silence would hide it.
    expect(await run(["probe"], d)).not.toBe(0);
    expect(err.join("\n")).toMatch(/persist/i);
  });
});

describe("mnemo harness hook", () => {
  it("exits zero and says nothing succeeded when the capture was not durable", async () => {
    const { deps: d, out } = deps({
      captureHook: vi.fn(async () => ({ durable: false, reason: "capacity_exhausted" })),
    });

    // Fail-open: a broken harness must never break the host's session.
    expect(await run(["hook"], d)).toBe(0);
    expect(out.join("\n")).not.toMatch(/captured|ok\b/i);
  });

  it("exits zero even when the hook itself throws", async () => {
    const { deps: d } = deps({
      captureHook: vi.fn(async () => {
        throw new Error("unsafe ownership on the harness root");
      }),
    });

    expect(await run(["hook"], d)).toBe(0);
  });

  it("never leaks a failure reason to the host's stdout", async () => {
    const { deps: d, out } = deps({
      captureHook: vi.fn(async () => {
        throw new Error(`could not write ${SECRET}`);
      }),
    });

    await run(["hook"], d);
    expect(out.join("\n")).not.toContain(SECRET);
  });
});

describe("dispatch", () => {
  it("prints help for no subcommand and for --help", async () => {
    for (const argv of [[], ["--help"], ["help"]]) {
      const { deps: d, out } = deps();
      await run(argv, d);
      expect(out.join("\n")).toContain("mnemo harness");
    }
  });

  it("rejects an undocumented subcommand instead of guessing", async () => {
    const { deps: d, err } = deps();

    expect(await run(["nuke"], d)).not.toBe(0);
    expect(err.join("\n")).toMatch(/unknown/i);
  });

  it("documents exactly the subcommands it dispatches", () => {
    for (const name of ["queue", "retry", "discard", "doctor", "hook", "probe"]) {
      expect(HARNESS_HELP).toContain(name);
    }
  });
});
