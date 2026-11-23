import { describe, expect, it, vi } from "vitest";
import { runHarnessLifecycle, type LifecycleDeps } from "../harness-uninstall.js";

function deps(overrides: Partial<LifecycleDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const base: LifecycleDeps = {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    confirm: vi.fn(async () => true),
    disableHost: vi.fn(async () => ({ disabled: true, ingestionStillAvailable: true })),
    drainQueue: vi.fn(async () => ({ remaining: 0, delivered: 3 })),
    quiesceWorkspace: vi.fn(async () => ({ quiesced: true, liveLeases: 0, inFlight: 0 })),
    removeArtifacts: vi.fn(async () => ({ removed: ["hooks.json entry"], preserved: ["theme"] })),
    readState: vi.fn(async () => ({ activated: false, queued: 0, quiesced: true })),
    ...overrides,
  };
  return { deps: base, out, err };
}

const run = (argv: string[], d: LifecycleDeps) => runHarnessLifecycle(argv, d);

describe("disable", () => {
  it("removes local activation but leaves the server accepting", async () => {
    const { deps: d, out } = deps();

    expect(await run(["disable", "opencode"], d)).toBe(0);

    expect(d.disableHost).toHaveBeenCalledWith({ host: "opencode" });
    // Queued events still belong to this workspace and still have somewhere to go.
    expect(d.drainQueue).not.toHaveBeenCalled();
    expect(out.join("\n")).toMatch(/ingestion.*available|still accept/i);
  });

  it("names a host, since disabling the wrong one is silent", async () => {
    const { deps: d, err } = deps();
    expect(await run(["disable"], d)).not.toBe(0);
    expect(err.join("\n")).toMatch(/host/i);
  });
});

describe("drain", () => {
  it("reports success only when the queue actually reached zero", async () => {
    const { deps: d, out } = deps();
    expect(await run(["drain"], d)).toBe(0);
    expect(out.join("\n")).toMatch(/0 remaining|drained/i);
  });

  it("fails when events are left behind", async () => {
    const { deps: d, err } = deps({
      drainQueue: vi.fn(async () => ({ remaining: 4, delivered: 1 })),
    });
    // Reporting a partial drain as done is how queued conversations get thrown away.
    expect(await run(["drain"], d)).not.toBe(0);
    expect(err.join("\n")).toContain("4");
  });
});

describe("quiesce", () => {
  it("fails while any lease or in-flight write remains", async () => {
    const { deps: d, err } = deps({
      quiesceWorkspace: vi.fn(async () => ({ quiesced: false, liveLeases: 2, inFlight: 1 })),
    });
    expect(await run(["quiesce"], d)).not.toBe(0);
    expect(err.join("\n")).toMatch(/lease/i);
  });
});

describe("uninstall enforces the order", () => {
  it("refuses while the host is still activated locally", async () => {
    const { deps: d, err } = deps({
      readState: vi.fn(async () => ({ activated: true, queued: 0, quiesced: true })),
    });

    expect(await run(["uninstall", "opencode"], d)).not.toBe(0);
    expect(d.removeArtifacts).not.toHaveBeenCalled();
    // Removing the artifacts while capture is live leaves a host writing into a
    // queue nothing will ever deliver.
    expect(err.join("\n")).toMatch(/disable/i);
  });

  it("refuses while events are still queued, unless told what to do with them", async () => {
    const { deps: d, err } = deps({
      readState: vi.fn(async () => ({ activated: false, queued: 7, quiesced: true })),
      confirm: vi.fn(async () => false),
    });

    expect(await run(["uninstall", "opencode"], d)).not.toBe(0);
    expect(d.removeArtifacts).not.toHaveBeenCalled();
    expect(err.join("\n")).toMatch(/queued|drain/i);
  });

  it("proceeds on queued events only with explicit discard confirmation", async () => {
    const confirm = vi.fn(async () => true);
    const { deps: d, out } = deps({
      readState: vi.fn(async () => ({ activated: false, queued: 7, quiesced: true })),
      confirm,
    });

    expect(await run(["uninstall", "opencode", "--discard-queued"], d)).toBe(0);
    expect(confirm).toHaveBeenCalled();
    expect(d.removeArtifacts).toHaveBeenCalled();
    // The operator must be told exactly what was thrown away.
    expect(out.join("\n")).toContain("7");
  });

  it("says server quiescence still needs action when it was skipped", async () => {
    const { deps: d, out } = deps({
      readState: vi.fn(async () => ({ activated: false, queued: 0, quiesced: false })),
    });

    expect(await run(["uninstall", "opencode"], d)).toBe(0);
    // Uninstalling locally does not fence the server; saying nothing would leave
    // an operator believing the rollback is complete.
    expect(out.join("\n")).toMatch(/quiesce/i);
  });

  it("removes only what Mnemosyne owns and reports what it left alone", async () => {
    const { deps: d, out } = deps();

    expect(await run(["uninstall", "opencode"], d)).toBe(0);

    const printed = out.join("\n");
    expect(printed).toContain("hooks.json entry");
    expect(printed).toMatch(/preserved|left/i);
    expect(printed).toContain("theme");
  });
});

describe("dispatch", () => {
  it("prints help for no subcommand", async () => {
    const { deps: d, out } = deps();
    await run([], d);
    for (const name of ["disable", "drain", "quiesce", "uninstall"]) {
      expect(out.join("\n")).toContain(name);
    }
  });

  it("rejects an unknown subcommand", async () => {
    const { deps: d } = deps();
    expect(await run(["obliterate"], d)).not.toBe(0);
  });
});
