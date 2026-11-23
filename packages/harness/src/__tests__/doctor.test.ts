import { mkdtempSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveBinding } from "../binding.js";
import { flushOutbox, type DeliveryTransport } from "../delivery.js";
import { writeCaptureConsent } from "../consent.js";
import { diagnoseHarness, type HostCaptureProbe } from "../doctor.js";
import { enqueueVisibleMessage } from "../outbox.js";

const roots: string[] = [];

function temporaryHome(): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "mnemo-harness-test-")));
  roots.push(home);
  return home;
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const BINDING = {
  serverUrl: "https://memory.example.com",
  workspaceId: "workspace-a",
  apiKey: "mns_live_doctortestkey0000000001",
};

function message(hostMessageId: string) {
  return {
    host: "codex" as const,
    hostSessionId: "session-1",
    clientInstanceId: "client-a",
    sourceGeneration: 0,
    hostMessageId,
    role: "user" as const,
    content: `content ${hostMessageId}`,
    occurredAt: "2026-09-10T00:00:00.000Z",
  };
}

const failing: DeliveryTransport = {
  async post() {
    return { status: 503, headers: {}, text: "" };
  },
};

describe("harness doctor", () => {
  it("reports a clean install with nothing queued", async () => {
    const home = temporaryHome();
    await resolveBinding(BINDING, { home });

    const report = await diagnoseHarness({ home });

    expect(report).toMatchObject({
      ok: true,
      queue: { count: 0, bytes: 0, oldestAgeSeconds: null, deadLetters: 0 },
      binding: { bound: true, workspaceId: "workspace-a" },
      capture: { fullFidelity: true },
    });
    expect(report.filesystem.mode).toBe("available");
  });

  it("says plainly that nothing is bound yet", async () => {
    const report = await diagnoseHarness({ home: temporaryHome() });

    expect(report.binding).toMatchObject({ bound: false });
    // Unbound is not healthy: capture would queue with nowhere to go.
    expect(report.ok).toBe(false);
  });

  it("counts what is queued, its bytes, and how long the oldest has waited", async () => {
    const home = temporaryHome();
    await resolveBinding(BINDING, { home });
    await enqueueVisibleMessage(message("m1"), { home });
    await enqueueVisibleMessage(message("m2"), { home });

    const report = await diagnoseHarness({ home });

    expect(report.queue.count).toBe(2);
    expect(report.queue.bytes).toBeGreaterThan(0);
    expect(report.queue.oldestAgeSeconds).toBeGreaterThanOrEqual(0);
  });

  it("surfaces the retry schedule an operator would otherwise have to guess at", async () => {
    const home = temporaryHome();
    await resolveBinding(BINDING, { home });
    await enqueueVisibleMessage(message("m1"), { home });
    await flushOutbox({ home, apiKey: BINDING.apiKey, transport: failing, random: () => 0.5 });

    const report = await diagnoseHarness({ home });

    expect(report.delivery.attempt).toBeGreaterThan(0);
    expect(report.delivery.nextAttemptAt).toBeTruthy();
    expect(report.delivery.blocked).toBeNull();
  });

  it("reports an operator block as the reason nothing is moving", async () => {
    const home = temporaryHome();
    await resolveBinding(BINDING, { home });
    await enqueueVisibleMessage(message("m1"), { home });
    await flushOutbox({
      home,
      apiKey: BINDING.apiKey,
      transport: {
        async post() {
          return { status: 401, headers: {}, text: "" };
        },
      },
    });

    const report = await diagnoseHarness({ home });

    expect(report.delivery.blocked).toMatchObject({ status: 401 });
    expect(report.ok).toBe(false);
  });

  it("proves the queue actually works, end to end, without touching the network", async () => {
    const home = temporaryHome();
    await resolveBinding(BINDING, { home });

    const report = await diagnoseHarness({ home, selfTest: true });

    expect(report.selfTest).toMatchObject({ ran: true, ok: true });
    // The probe must leave nothing behind, or doctor would grow the queue it measures.
    expect((await diagnoseHarness({ home })).queue.count).toBe(0);
  });

  it("skips the self test unless asked, so a diagnosis never writes by surprise", async () => {
    const home = temporaryHome();
    await resolveBinding(BINDING, { home });

    expect((await diagnoseHarness({ home })).selfTest).toMatchObject({ ran: false });
  });

  it("never reveals the API key or a captured message", async () => {
    const home = temporaryHome();
    await resolveBinding(BINDING, { home });
    await enqueueVisibleMessage(
      { ...message("m1"), content: "SECRET-CONTENT-IN-A-MESSAGE" },
      { home }
    );

    const serialized = JSON.stringify(await diagnoseHarness({ home }));

    // A doctor report is the thing users paste into an issue.
    expect(serialized).not.toContain(BINDING.apiKey);
    expect(serialized).not.toContain("SECRET-CONTENT-IN-A-MESSAGE");
  });

  it("never throws, however broken the install is", async () => {
    // A home that cannot hold a harness at all: diagnosis is exactly when this
    // must still answer.
    const report = await diagnoseHarness({ home: join(temporaryHome(), "missing", "deeper") });
    expect(report.ok).toBe(false);
  });
});

describe("harness doctor, per host capture mode (APP-034d)", () => {
  const full = { mode: "full" as const, reason: "qualified" };
  const probe = (overrides: Partial<HostCaptureProbe> = {}): HostCaptureProbe => ({
    qualification: () => full,
    liveGate: () => ({ mode: "full", reason: "no feature gate" }),
    artifactHash: () => "hash-now",
    env: {},
    ...overrides,
  });
  const consent = (
    home: string,
    host: "claude-code" | "codex",
    mode: "full" | "user-only" | "mcp-only"
  ) => writeCaptureConsent({ host, mode, hostVersion: "1.0.0", packageHash: "hash-now" }, { home });
  const hostLine = async (home: string, host: string, p: HostCaptureProbe) =>
    (await diagnoseHarness({ home, captureHosts: p })).hosts?.find((h) => h.host === host);

  it("reports every host, with a reason, when nothing was consented", async () => {
    const home = temporaryHome();
    const report = await diagnoseHarness({ home, captureHosts: probe() });
    expect(report.hosts?.map((h) => h.host)).toEqual(["opencode", "claude-code", "codex"]);
    for (const host of report.hosts ?? []) {
      expect(host).toMatchObject({ consented: null, mode: "mcp-only" });
      expect(host.reason).toMatch(/consent/);
    }
    // Not consenting is a choice, not a fault.
    expect(report.problems.filter((p) => p.startsWith("capture_dropped"))).toEqual([]);
  });

  it("keeps the consented mode when nothing lowers it", async () => {
    const home = temporaryHome();
    await consent(home, "claude-code", "user-only");
    expect(await hostLine(home, "claude-code", probe())).toMatchObject({
      consented: "user-only",
      mode: "user-only",
    });
  });

  it("says when a stale qualification record dropped the mode", async () => {
    const home = temporaryHome();
    await consent(home, "codex", "user-only");
    const report = await diagnoseHarness({
      home,
      captureHosts: probe({
        qualification: (host) =>
          host === "codex"
            ? {
                mode: "mcp-only",
                reason: "qualification is for host version 0.163.0, this is 0.169.0",
              }
            : full,
      }),
    });
    const codex = report.hosts?.find((h) => h.host === "codex");
    expect(codex).toMatchObject({ consented: "user-only", mode: "mcp-only" });
    expect(codex?.reason).toContain("0.169.0");
    expect(report.problems).toContain("capture_dropped_codex");
  });

  it("says when the capture artifacts changed since consent", async () => {
    const home = temporaryHome();
    await consent(home, "claude-code", "user-only");
    const line = await hostLine(home, "claude-code", probe({ artifactHash: () => "hash-later" }));
    expect(line).toMatchObject({ mode: "mcp-only" });
    expect(line?.reason).toMatch(/artifacts changed/);
  });

  it("says when the live host gate is closed", async () => {
    const home = temporaryHome();
    await consent(home, "codex", "user-only");
    const line = await hostLine(
      home,
      "codex",
      probe({ liveGate: () => ({ mode: "mcp-only", reason: "features.hooks is off" }) })
    );
    expect(line).toMatchObject({ mode: "mcp-only" });
    expect(line?.reason).toContain("features.hooks is off");
  });

  it("names the kill switch and the consented mcp-only marker", async () => {
    const home = temporaryHome();
    await consent(home, "claude-code", "user-only");
    await consent(home, "codex", "mcp-only");
    const killed = await hostLine(
      home,
      "claude-code",
      probe({ env: { MNEMO_HARNESS_V1_ENABLED: "false" } })
    );
    expect(killed).toMatchObject({ mode: "mcp-only" });
    expect(killed?.reason).toContain("MNEMO_HARNESS_V1_ENABLED");
    const line = await hostLine(home, "codex", probe());
    expect(line).toMatchObject({ consented: "mcp-only", mode: "mcp-only" });
    expect(line?.reason).toMatch(/mcp-only/);
  });

  it("leaves the per-host section out when no probe is given", async () => {
    expect((await diagnoseHarness({ home: temporaryHome() })).hosts).toBeUndefined();
  });
});
