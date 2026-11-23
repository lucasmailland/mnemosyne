import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

// Some cases spawn tsx children that SIGKILL themselves mid-write; a cold
// start under a full parallel sweep took past the 5 s default (5.2 s seen).
vi.setConfig({ testTimeout: 30_000 });
import { canonicalJson } from "@mnemo-ai/types";
import {
  HARNESS_MAX_IDENTITY_BYTES,
  HARNESS_MAX_MESSAGE_BYTES,
} from "@mnemo-ai/types/harness-runtime";
import { ensureSecureHarnessPaths } from "../fs-security.js";
import { computePayloadHash } from "../protocol.js";
import { acknowledgeEvent } from "../state.js";
import {
  enqueueEventCancellation,
  enqueueVisibleMessage,
  readPendingEvents,
  replaceUnseenWithLoss,
  type EnqueueVisibleMessageInput,
} from "../outbox.js";

const roots: string[] = [];
const sourceRoot = fileURLToPath(new URL("..", import.meta.url));
const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
const secret = "sk-proj-OutboxSecretValue123456789";

function temporaryHome(): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "mnemo-harness-test-")));
  roots.push(home);
  return home;
}

function input(
  hostSessionId = "session-1",
  hostMessageId = "message-1"
): EnqueueVisibleMessageInput {
  return {
    host: "opencode",
    hostSessionId,
    clientInstanceId: "client-1",
    sourceGeneration: 0,
    hostMessageId,
    role: "user",
    content: `hello OPENAI_API_KEY=${secret}`,
    occurredAt: "2000-01-01T00:00:00.000Z",
  };
}

function waitForLine(child: ChildProcessWithoutNullStreams, expected: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
      if (output.includes(`${expected}\n`)) resolve();
    });
    child.stderr.once("data", (chunk) => reject(new Error(String(chunk))));
    child.once("error", reject);
  });
}

function waitForExit(
  child: ChildProcessWithoutNullStreams
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

async function hardExitEnqueueAt(
  home: string,
  area: "outbox" | "state",
  boundary: "temp-open" | "temp-write" | "temp-fsync" | "rename" | "directory-fsync",
  message = input()
): Promise<void> {
  await ensureSecureHarnessPaths({ home });
  const script = [
    `import { enqueueVisibleMessage } from ${JSON.stringify(join(sourceRoot, "outbox.ts"))};`,
    `(async () => {`,
    `await enqueueVisibleMessage(JSON.parse(process.argv[1]), {`,
    `home: process.argv[2],`,
    `boundary: (boundary, path) => {`,
    `const area = path.includes("/outbox/") || path.endsWith("/outbox") ? "outbox" : path.includes("/state/") || path.endsWith("/state") ? "state" : undefined;`,
    `if (area === process.argv[3] && boundary === process.argv[4]) process.kill(process.pid, "SIGKILL");`,
    `},`,
    `});`,
    `})().catch((error) => { console.error(error); process.exit(1); });`,
  ].join("\n");
  const child = spawn(
    process.execPath,
    [tsxCli, "--eval", script, JSON.stringify(message), home, area, boundary],
    { stdio: "pipe" }
  );
  const exit = await waitForExit(child);
  expect(exit.signal === "SIGKILL" || exit.code === 128 + 9).toBe(true);
}

function directoryBytes(path: string): number {
  return readdirSync(path).reduce((total, name) => total + statSync(join(path, name)).size, 0);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("secure outbox", () => {
  it("persists only canonical sanitized bytes through the public boundary", async () => {
    const home = temporaryHome();
    const result = await enqueueVisibleMessage(input(), { home });
    const bytes = readFileSync(result.path, "utf8");
    const event = JSON.parse(bytes) as Record<string, unknown>;

    expect(bytes).toBe(canonicalJson(event));
    expect(bytes).not.toContain(secret);
    expect(event.content).toContain("[REDACTED]");
    expect(event.enqueueSequence).toBe(1);
    expect(result.fullFidelity).toBe(true);
  });

  it("serializes cross-process allocation for one session", async () => {
    const home = temporaryHome();
    const script = [
      `import { enqueueVisibleMessage } from ${JSON.stringify(join(sourceRoot, "outbox.ts"))};`,
      `(async () => {`,
      `process.stdout.write("ready\\n"); await new Promise((resolve) => process.stdin.once("data", resolve));`,
      `await enqueueVisibleMessage(JSON.parse(process.argv[1]), { home: process.argv[2] });`,
      `})().catch((error) => { console.error(error); process.exit(1); });`,
    ].join("\n");
    const children = Array.from({ length: 8 }, (_, index) =>
      spawn(
        process.execPath,
        [tsxCli, "--eval", script, JSON.stringify(input("race", `message-${index}`)), home],
        { stdio: "pipe" }
      )
    );
    await Promise.all(children.map((child) => waitForLine(child, "ready")));
    for (const child of children) child.stdin.end("go\n");
    const exits = await Promise.all(
      children.map(
        (child) =>
          new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)))
      )
    );

    expect(exits).toEqual(Array(8).fill(0));
    const events = await readPendingEvents({ home });
    expect(events.map(({ event }) => event.enqueueSequence).sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
  }, 30_000);

  it("serializes global capacity admission across child processes and sessions", async () => {
    const home = temporaryHome();
    const sampleHome = temporaryHome();
    const sample = await enqueueVisibleMessage(
      { ...input("sample", "sample"), content: "small" },
      {
        home: sampleHome,
      }
    );
    const normalBytes = sample.bytes + 128;
    const script = [
      `import { enqueueVisibleMessage } from ${JSON.stringify(join(sourceRoot, "outbox.ts"))};`,
      `(async () => {`,
      `process.stdout.write("ready\\n"); await new Promise((resolve) => process.stdin.once("data", resolve));`,
      `await enqueueVisibleMessage(JSON.parse(process.argv[1]), { home: process.argv[2], capacity: { normalBytes: ${normalBytes}, markerReserveBytes: 65536 } });`,
      `})().catch((error) => { console.error(error); process.exit(1); });`,
    ].join("\n");
    const children = Array.from({ length: 4 }, (_, index) =>
      spawn(
        process.execPath,
        [
          tsxCli,
          "--eval",
          script,
          JSON.stringify({ ...input(`capacity-${index}`, `message-${index}`), content: "small" }),
          home,
        ],
        { stdio: "pipe" }
      )
    );
    await Promise.all(children.map((child) => waitForLine(child, "ready")));
    for (const child of children) child.stdin.end("go\n");
    const exits = await Promise.all(
      children.map((child) => new Promise<number | null>((resolve) => child.once("exit", resolve)))
    );
    const events = await readPendingEvents({ home });

    expect(exits).toEqual(Array(4).fill(0));
    expect(events.filter(({ event }) => event.type === "turn.append")).toHaveLength(1);
    expect(events.filter(({ event }) => event.type === "sequence.loss")).toHaveLength(3);
  }, 30_000);

  it("atomically protects the normal ceiling across sessions and uses marker reserve", async () => {
    const home = temporaryHome();
    const first = await enqueueVisibleMessage(input("a", "a"), {
      home,
      capacity: { normalBytes: 1, markerReserveBytes: 16_384 },
    });
    const second = await enqueueVisibleMessage(input("b", "b"), {
      home,
      capacity: { normalBytes: 1, markerReserveBytes: 16_384 },
    });
    const events = await readPendingEvents({ home });

    expect(first.event.type).toBe("sequence.loss");
    expect(second.event.type).toBe("sequence.loss");
    expect(events.every(({ event }) => event.type === "sequence.loss")).toBe(true);
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(readdirSync((await ensureSecureHarnessPaths({ home })).audit)).toHaveLength(2);
  });

  it("does not consume marker reserve with normal events or evict pending files", async () => {
    const home = temporaryHome();
    const accepted = await enqueueVisibleMessage(
      { ...input(), content: "small" },
      {
        home,
        capacity: { normalBytes: 2_000, markerReserveBytes: 4_096 },
      }
    );
    const before = readFileSync(accepted.path, "utf8");
    const rejected = await enqueueVisibleMessage(input("other", "large"), {
      home,
      capacity: { normalBytes: Buffer.byteLength(before), markerReserveBytes: 4_096 },
    });

    expect(readFileSync(accepted.path, "utf8")).toBe(before);
    expect(rejected.event.type).toBe("sequence.loss");
  });

  it("replaces an unseen undeliverable event at the same sequence", async () => {
    const home = temporaryHome();
    const original = await enqueueVisibleMessage({ ...input(), content: "safe" }, { home });
    const replacement = await replaceUnseenWithLoss(original.event.eventId, "permanent_rejection", {
      home,
    });

    expect(replacement.event.type).toBe("sequence.loss");
    expect(replacement.event.enqueueSequence).toBe(original.event.enqueueSequence);
    expect(replacement.event.eventId).not.toBe(original.event.eventId);
    expect(readFileSync(replacement.path, "utf8")).not.toContain("safe");
  });

  it("preserves an acknowledged pending final when loss replacement is rejected", async () => {
    const home = temporaryHome();
    const original = await enqueueVisibleMessage({ ...input(), content: "safe" }, { home });
    if (original.event.type !== "turn.append") throw new Error("Expected append");
    await acknowledgeEvent(
      original.event.host,
      original.event.clientInstanceId,
      original.event.hostSessionId,
      original.event,
      { home }
    );
    const bytes = readFileSync(original.path, "utf8");

    // Simulate restart after durable acknowledgement but before pending-file unlink.
    await expect(
      replaceUnseenWithLoss(original.event.eventId, "permanent_rejection", { home })
    ).rejects.toThrow();

    expect(readFileSync(original.path, "utf8")).toBe(bytes);
    expect((await readPendingEvents({ home })).map(({ event }) => event)).toEqual([original.event]);
    const next = await enqueueVisibleMessage(input("session-1", "message-2"), { home });
    expect(next.event.enqueueSequence).toBe(original.event.enqueueSequence + 1);
  });

  it("recovers a same-sequence loss replacement after a hard exit following rename", async () => {
    const home = temporaryHome();
    const original = await enqueueVisibleMessage({ ...input(), content: "safe" }, { home });
    const script = [
      `import { replaceUnseenWithLoss } from ${JSON.stringify(join(sourceRoot, "outbox.ts"))};`,
      `(async () => { await replaceUnseenWithLoss(process.argv[1], "permanent_rejection", {`,
      `home: process.argv[2], boundary: (boundary, path) => {`,
      `if (boundary === "rename" && path.includes("/outbox/")) process.kill(process.pid, "SIGKILL");`,
      `} }); })().catch(() => process.exit(1));`,
    ].join("\n");
    const child = spawn(
      process.execPath,
      [tsxCli, "--eval", script, original.event.eventId, home],
      {
        stdio: "pipe",
      }
    );

    const exit = await waitForExit(child);
    expect(exit.signal === "SIGKILL" || exit.code === 128 + 9).toBe(true);
    const recovered = await readPendingEvents({ home });
    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.event).toMatchObject({
      type: "sequence.loss",
      enqueueSequence: original.event.enqueueSequence,
    });
  });

  it("persists a seen retryable event cancellation later from marker reserve", async () => {
    const home = temporaryHome();
    const original = await enqueueVisibleMessage({ ...input(), content: "safe" }, { home });
    const cancellation = await enqueueEventCancellation(
      {
        host: "opencode",
        hostSessionId: "session-1",
        clientInstanceId: "client-1",
        sourceGeneration: 0,
        targetEventId: original.event.eventId,
        reason: "generation_redirect",
        occurredAt: "2000-01-01T00:00:00.000Z",
      },
      { home, capacity: { normalBytes: original.bytes, markerReserveBytes: 4096 } }
    );

    expect(cancellation.event).toMatchObject({
      type: "event.cancel",
      enqueueSequence: 2,
      targetEventId: original.event.eventId,
    });
    expect(readFileSync(cancellation.path, "utf8")).not.toContain("safe");
  });

  it("never reports durable success when marker or audit persistence fails", async () => {
    const home = temporaryHome();
    await expect(
      enqueueVisibleMessage(input(), {
        home,
        capacity: { normalBytes: 1, markerReserveBytes: 1 },
      })
    ).rejects.toMatchObject({ fullFidelity: false });
    const paths = await ensureSecureHarnessPaths({ home });
    expect(readFileSync(join(paths.state, "full-fidelity.json"), "utf8")).toContain(
      '"fullFidelity":false'
    );

    const later = await enqueueVisibleMessage({ ...input(), content: "safe" }, { home });
    expect(later.fullFidelity).toBe(false);
  });

  it("keeps full fidelity false after an acknowledged loss marker is removed", async () => {
    const home = temporaryHome();
    const loss = await enqueueVisibleMessage(input(), {
      home,
      capacity: { normalBytes: 1, markerReserveBytes: 16_384 },
    });
    expect(loss.event.type).toBe("sequence.loss");
    if (loss.event.type !== "sequence.loss") throw new Error("Expected a loss event");

    await acknowledgeEvent(
      loss.event.host,
      loss.event.clientInstanceId,
      loss.event.hostSessionId,
      {
        type: loss.event.type,
        eventId: loss.event.eventId,
        enqueueSequence: loss.event.enqueueSequence,
        sourceGeneration: loss.event.sourceGeneration,
        reason: loss.event.reason,
        lostEventType: loss.event.lostEventType,
        lostHostMessageId: loss.event.lostHostMessageId,
        lostRole: loss.event.lostRole,
        lostContentHash: loss.event.lostContentHash,
      },
      { home }
    );
    unlinkSync(loss.path);

    const later = await enqueueVisibleMessage({ ...input(), hostMessageId: "message-2" }, { home });
    expect(later.fullFidelity).toBe(false);
  });

  it("rejects invalid wire identity and capacity before persistence", async () => {
    const home = temporaryHome();
    await expect(
      enqueueVisibleMessage({ ...input(), sourceGeneration: -1 }, { home })
    ).rejects.toThrow(/generation/i);
    await expect(
      enqueueVisibleMessage(input(), {
        home,
        capacity: { normalBytes: Number.POSITIVE_INFINITY, markerReserveBytes: 1 },
      })
    ).rejects.toThrow(/capacity/i);
    expect(await readPendingEvents({ home })).toEqual([]);
  });

  it.each(["hostSessionId", "clientInstanceId", "hostMessageId"] as const)(
    "rejects %s above the protocol byte limit before persistence",
    async (field) => {
      const home = temporaryHome();
      await expect(
        enqueueVisibleMessage(
          { ...input(), [field]: "é".repeat(Math.floor(HARNESS_MAX_IDENTITY_BYTES / 2) + 1) },
          { home }
        )
      ).rejects.toThrow(/identity.*bytes/i);
      expect(await readPendingEvents({ home })).toEqual([]);
    }
  );

  it("never promotes uncommitted temporary files and latches fidelity loss", async () => {
    const home = temporaryHome();
    const original = await enqueueVisibleMessage({ ...input(), content: "sanitized" }, { home });
    const paths = await ensureSecureHarnessPaths({ home });
    const finalName = original.path.split("/").at(-1)!;
    renameSync(
      original.path,
      join(paths.outbox, `.${finalName}.11111111-1111-4111-8111-111111111111.tmp`)
    );
    writeFileSync(
      join(paths.outbox, ".broken.json.22222222-2222-4222-8222-222222222222.tmp"),
      `plaintext ${secret}`,
      { mode: 0o600 }
    );

    const pending = await readPendingEvents({ home });

    expect(pending).toEqual([]);
    expect(readdirSync(paths.outbox).some((name) => name.endsWith(".tmp"))).toBe(false);
    expect(JSON.stringify(readdirSync(paths.quarantine))).not.toContain(secret);
    expect(readFileSync(join(paths.state, "full-fidelity.json"), "utf8")).toContain(
      '"fullFidelity":false'
    );
  });

  it("does not recover state temporary files without the owning session lock", async () => {
    const home = temporaryHome();
    const paths = await ensureSecureHarnessPaths({ home });
    const temporaryName = ".other-session.json.11111111-1111-4111-8111-111111111111.tmp";
    writeFileSync(join(paths.state, temporaryName), canonicalJson({ version: 1 }), { mode: 0o600 });
    const fidelityTemp = ".full-fidelity.json.22222222-2222-4222-8222-222222222222.tmp";
    writeFileSync(
      join(paths.state, fidelityTemp),
      canonicalJson({ version: 1, fullFidelity: false, reason: "prior_failure" }),
      { mode: 0o600 }
    );

    const result = await enqueueVisibleMessage(input(), { home });

    expect(readdirSync(paths.state)).toContain(temporaryName);
    expect(readdirSync(paths.state)).not.toContain(fidelityTemp);
    expect(result.fullFidelity).toBe(false);
  });

  it("quarantines malformed finals under the global lock without wedging valid events", async () => {
    const home = temporaryHome();
    const valid = await enqueueVisibleMessage({ ...input(), content: "safe" }, { home });
    const paths = await ensureSecureHarnessPaths({ home });
    writeFileSync(join(paths.outbox, "malformed.json"), "{not-json", { mode: 0o600 });

    const pending = await readPendingEvents({ home });

    expect(pending.map(({ event }) => event.eventId)).toEqual([valid.event.eventId]);
    expect(readdirSync(paths.outbox)).not.toContain("malformed.json");
    expect(readdirSync(paths.quarantine)).toHaveLength(1);
    const later = await enqueueVisibleMessage(input("later", "later"), { home });
    expect(later.fullFidelity).toBe(false);
  });

  it("quarantines canonical self-hashed finals with invalid protocol fields", async () => {
    const home = temporaryHome();
    const paths = await ensureSecureHarnessPaths({ home });
    const body = {
      eventId: "event-invalid",
      host: "opencode",
      hostSessionId: "session-1",
      clientInstanceId: "client-1",
      enqueueSequence: 1,
      occurredAt: "2000-01-01T00:00:00.000Z",
      normalizationVersion: 1,
      type: "turn.append",
      sourceGeneration: 0,
      hostMessageId: "message-1",
      role: "system",
      content: "invalid",
      contentHash: "a".repeat(64),
    };
    writeFileSync(
      join(paths.outbox, "invalid.json"),
      canonicalJson({ ...body, payloadHash: computePayloadHash(body) }),
      { mode: 0o600 }
    );

    expect(await readPendingEvents({ home })).toEqual([]);
    expect(readdirSync(paths.quarantine)).toHaveLength(1);
  });

  it("quarantines strict-schema violations and oversized recovered messages", async () => {
    const home = temporaryHome();
    const paths = await ensureSecureHarnessPaths({ home });
    const valid = await enqueueVisibleMessage(input("strict", "strict"), { home });
    const { payloadHash: _payloadHash, ...validBody } = valid.event;
    const withExtra = { ...validBody, extra: true };
    writeFileSync(
      valid.path,
      canonicalJson({ ...withExtra, payloadHash: computePayloadHash(withExtra) }),
      {
        mode: 0o600,
      }
    );
    const oversizedContent = "x".repeat(HARNESS_MAX_MESSAGE_BYTES + 1);
    const oversizedBody = {
      ...validBody,
      eventId: "oversized-event",
      hostSessionId: "oversized",
      content: oversizedContent,
      contentHash: createHash("sha256").update(oversizedContent).digest("hex"),
    };
    writeFileSync(
      join(paths.outbox, "oversized.json"),
      canonicalJson({ ...oversizedBody, payloadHash: computePayloadHash(oversizedBody) }),
      { mode: 0o600 }
    );

    expect(await readPendingEvents({ home })).toEqual([]);
    expect(readdirSync(paths.quarantine)).toHaveLength(2);
  });

  it("rejects non-ISO occurredAt values before persisting an event", async () => {
    const home = temporaryHome();
    await expect(
      enqueueVisibleMessage({ ...input(), occurredAt: "September 1, 2026" }, { home })
    ).rejects.toThrow(/occurredAt/i);
    expect(await readPendingEvents({ home })).toEqual([]);
  });

  it("validates replacement capacity options", async () => {
    const home = temporaryHome();
    const original = await enqueueVisibleMessage(input(), { home });
    await expect(
      replaceUnseenWithLoss(original.event.eventId, "permanent_rejection", {
        home,
        capacity: { normalBytes: 1, markerReserveBytes: Number.NaN },
      })
    ).rejects.toThrow(/capacity/i);
    await expect(
      replaceUnseenWithLoss(original.event.eventId, "unknown" as never, { home })
    ).rejects.toThrow(/reason/i);
  });

  it("fails closed when the durable fidelity latch is malformed", async () => {
    const home = temporaryHome();
    const paths = await ensureSecureHarnessPaths({ home });
    writeFileSync(join(paths.state, "full-fidelity.json"), canonicalJson({}), { mode: 0o600 });

    const result = await enqueueVisibleMessage(input(), { home });

    expect(result.fullFidelity).toBe(false);
  });

  it("does not admit new bytes until a malformed-final quarantine move is durable", async () => {
    const home = temporaryHome();
    const paths = await ensureSecureHarnessPaths({ home });
    writeFileSync(join(paths.outbox, "malformed.json"), "{not-json", { mode: 0o600 });
    let failed = false;

    await expect(
      enqueueVisibleMessage(
        { ...input(), content: "safe" },
        {
          home,
          boundary: (boundary, path) => {
            if (!failed && boundary === "directory-fsync" && path === paths.quarantine) {
              failed = true;
              throw new Error("quarantine fsync failed");
            }
          },
        }
      )
    ).rejects.toThrow(/quarantine fsync failed/i);
    expect(readdirSync(paths.outbox).filter((name) => name.endsWith(".json"))).toEqual([]);

    const recovered = await enqueueVisibleMessage({ ...input(), content: "safe" }, { home });
    expect(recovered.event.enqueueSequence).toBe(1);
  });

  it("repairs a quarantine audit after a hard exit between move and audit durability", async () => {
    const home = temporaryHome();
    const paths = await ensureSecureHarnessPaths({ home });
    writeFileSync(join(paths.outbox, "malformed.json"), "{not-json", { mode: 0o600 });
    const script = [
      `import { readPendingEvents } from ${JSON.stringify(join(sourceRoot, "outbox.ts"))};`,
      `(async () => {`,
      `await readPendingEvents({ home: process.argv[1], boundary: (boundary, path) => {`,
      `if (boundary === "temp-open" && path.includes("/audit/")) process.kill(process.pid, "SIGKILL");`,
      `} });`,
      `})().catch((error) => { console.error(error); process.exit(1); });`,
    ].join("\n");
    const child = spawn(process.execPath, [tsxCli, "--eval", script, home], { stdio: "pipe" });
    const exit = await waitForExit(child);
    expect(exit.signal === "SIGKILL" || exit.code === 128 + 9).toBe(true);

    await expect(readPendingEvents({ home })).resolves.toEqual([]);
    expect(readdirSync(paths.quarantine)).toHaveLength(1);
    expect(readdirSync(paths.audit)).toHaveLength(1);
    expect(readFileSync(join(paths.state, "full-fidelity.json"), "utf8")).toContain(
      '"fullFidelity":false'
    );
  });

  it("syncs an existing audit before discarding its quarantine repair source", async () => {
    const home = temporaryHome();
    const paths = await ensureSecureHarnessPaths({ home });
    writeFileSync(join(paths.outbox, "malformed.json"), "{not-json", { mode: 0o600 });
    const crashAfterAuditRename = [
      `import { readPendingEvents } from ${JSON.stringify(join(sourceRoot, "outbox.ts"))};`,
      `(async () => { await readPendingEvents({ home: process.argv[1], boundary: (boundary, path) => {`,
      `if (boundary === "rename" && path.includes("/audit/")) process.kill(process.pid, "SIGKILL");`,
      `} }); })().catch(() => process.exit(1));`,
    ].join("\n");
    const first = spawn(process.execPath, [tsxCli, "--eval", crashAfterAuditRename, home], {
      stdio: "pipe",
    });
    const firstExit = await waitForExit(first);
    expect(firstExit.signal === "SIGKILL" || firstExit.code === 128 + 9).toBe(true);

    const crashAfterRepairSync = [
      `import { readPendingEvents } from ${JSON.stringify(join(sourceRoot, "outbox.ts"))};`,
      `(async () => { await readPendingEvents({ home: process.argv[1], boundary: (boundary, path) => {`,
      `if (boundary === "directory-fsync" && path.endsWith("/audit")) process.kill(process.pid, "SIGKILL");`,
      `} }); })().catch(() => process.exit(1));`,
    ].join("\n");
    const second = spawn(process.execPath, [tsxCli, "--eval", crashAfterRepairSync, home], {
      stdio: "pipe",
    });
    const secondExit = await waitForExit(second);
    expect(secondExit.signal === "SIGKILL" || secondExit.code === 128 + 9).toBe(true);
    expect(readdirSync(paths.quarantine)).toHaveLength(1);

    await expect(readPendingEvents({ home })).resolves.toEqual([]);
    expect(readdirSync(paths.audit)).toHaveLength(1);
  });

  it("bounds caller-derived session lock files", async () => {
    const home = temporaryHome();
    for (let index = 0; index < 34; index += 1) {
      await enqueueVisibleMessage(input(`bounded-lock-${index}`, `message-${index}`), {
        home,
        capacity: { normalBytes: 1, markerReserveBytes: 1 },
      }).catch(() => undefined);
    }

    const paths = await ensureSecureHarnessPaths({ home });
    expect(readdirSync(paths.locks).length).toBeLessThanOrEqual(33);
  }, 15_000);

  it("repairs a marker-exhaustion loss audit after a hard exit during audit persistence", async () => {
    const home = temporaryHome();
    const script = [
      `import { enqueueVisibleMessage } from ${JSON.stringify(join(sourceRoot, "outbox.ts"))};`,
      `(async () => {`,
      `await enqueueVisibleMessage(JSON.parse(process.argv[1]), {`,
      `home: process.argv[2], capacity: { normalBytes: 1, markerReserveBytes: 1 },`,
      `boundary: (boundary, path) => {`,
      `if (boundary === "temp-open" && path.includes("/audit/")) process.kill(process.pid, "SIGKILL");`,
      `},`,
      `});`,
      `})().catch((error) => { console.error(error); process.exit(1); });`,
    ].join("\n");
    const child = spawn(
      process.execPath,
      [tsxCli, "--eval", script, JSON.stringify(input()), home],
      { stdio: "pipe" }
    );
    const exit = await waitForExit(child);
    expect(exit.signal === "SIGKILL" || exit.code === 128 + 9).toBe(true);

    expect(await readPendingEvents({ home })).toEqual([]);
    const paths = await ensureSecureHarnessPaths({ home });
    const audits = readdirSync(paths.audit).map((name) =>
      readFileSync(join(paths.audit, name), "utf8")
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toContain('"lostHostMessageId":"message-1"');
    expect(readdirSync(paths.quarantine)).toEqual([]);
  });

  it("bounds quarantine and audit storage under repeated failures", async () => {
    const home = temporaryHome();
    const paths = await ensureSecureHarnessPaths({ home });
    const capacity = {
      normalBytes: 1024,
      markerReserveBytes: 1,
      quarantineBytes: 32,
      auditBytes: 512,
    };
    for (let index = 0; index < 8; index += 1) {
      writeFileSync(join(paths.outbox, `malformed-${index}.json`), "{not-json", { mode: 0o600 });
      await readPendingEvents({ home, capacity }).catch(() => undefined);
      await enqueueVisibleMessage(input(`loss-${index}`, `message-${index}`), {
        home,
        capacity,
      }).catch(() => undefined);
    }

    expect(directoryBytes(paths.quarantine)).toBeLessThanOrEqual(capacity.quarantineBytes);
    expect(directoryBytes(paths.audit)).toBeLessThanOrEqual(capacity.auditBytes);
    expect(readFileSync(join(paths.state, "full-fidelity.json"), "utf8")).toContain(
      '"fullFidelity":false'
    );
  }, 30_000);

  it.each([
    ["outbox", "temp-open"],
    ["outbox", "temp-write"],
    ["outbox", "temp-fsync"],
    ["outbox", "rename"],
    ["outbox", "directory-fsync"],
    ["state", "temp-open"],
    ["state", "temp-write"],
    ["state", "temp-fsync"],
    ["state", "rename"],
    ["state", "directory-fsync"],
  ] as const)(
    "attempts identity-complete loss audit and latches degraded state after normal %s %s failure",
    async (failedArea, failedBoundary) => {
      const home = temporaryHome();
      let failed = false;
      await expect(
        enqueueVisibleMessage(
          { ...input(), content: "safe" },
          {
            home,
            boundary: (boundary, path) => {
              if (!failed && boundary === failedBoundary && path.includes(`/${failedArea}`)) {
                failed = true;
                throw new Error(`injected ${failedBoundary}`);
              }
            },
          }
        )
      ).rejects.toMatchObject({ fullFidelity: false });

      const paths = await ensureSecureHarnessPaths({ home });
      const audits = readdirSync(paths.audit).map((name) =>
        readFileSync(join(paths.audit, name), "utf8")
      );
      expect(audits.join("\n")).toContain('"lostHostMessageId":"message-1"');
      expect(audits.join("\n")).toContain('"lostContentHash"');
      expect(readFileSync(join(paths.state, "full-fidelity.json"), "utf8")).toContain(
        '"fullFidelity":false'
      );
      expect(readdirSync(paths.outbox).some((name) => name.endsWith(".tmp"))).toBe(false);
      const recovered = await readPendingEvents({ home });
      for (const { event } of recovered) {
        await acknowledgeEvent(event.host, event.clientInstanceId, event.hostSessionId, event, {
          home,
        });
      }
      const next = await enqueueVisibleMessage(input("session-1", "message-2"), { home });
      expect(next.event.enqueueSequence).toBe(
        Math.max(0, ...recovered.map(({ event }) => event.enqueueSequence)) + 1
      );
    }
  );

  it("does not exceed the loss reserve during persistence failure recovery", async () => {
    const home = temporaryHome();
    let failed = false;
    await expect(
      enqueueVisibleMessage(input(), {
        home,
        capacity: { markerReserveBytes: 0 },
        boundary: (boundary, path) => {
          if (!failed && boundary === "temp-write" && path.includes("/outbox/")) {
            failed = true;
            throw new Error("injected write failure");
          }
        },
      })
    ).rejects.toMatchObject({ fullFidelity: false });
    expect(await readPendingEvents({ home })).toEqual([]);
    const paths = await ensureSecureHarnessPaths({ home });
    expect(readdirSync(paths.audit)).not.toHaveLength(0);
  });

  it("audits cancellation admission failure without persisting capture content", async () => {
    const home = temporaryHome();
    await expect(
      enqueueEventCancellation(
        { ...input(), targetEventId: "retryable-event", reason: "terminal_rebuild" },
        { home, capacity: { markerReserveBytes: 0 } }
      )
    ).rejects.toMatchObject({ fullFidelity: false });
    const paths = await ensureSecureHarnessPaths({ home });
    const audits = readdirSync(paths.audit).map((name) =>
      JSON.parse(readFileSync(join(paths.audit, name), "utf8"))
    );
    expect(audits).toEqual([
      expect.objectContaining({ reason: "capacity", lostEventType: "event.cancel" }),
    ]);
    expect(JSON.stringify(audits)).not.toContain(secret);
    expect(await readPendingEvents({ home })).toEqual([]);
  });

  it.each(["temp-open", "temp-write", "temp-fsync"] as const)(
    "fails closed after a hard exit at outbox %s without promoting its temp",
    async (boundary) => {
      const home = temporaryHome();
      await hardExitEnqueueAt(home, "outbox", boundary, { ...input(), content: "safe" });

      expect(await readPendingEvents({ home })).toEqual([]);
      const paths = await ensureSecureHarnessPaths({ home });
      expect(readdirSync(paths.outbox).some((name) => name.endsWith(".tmp"))).toBe(false);
      expect(readFileSync(join(paths.state, "full-fidelity.json"), "utf8")).toContain(
        '"fullFidelity":false'
      );
    }
  );

  it.each([
    ["outbox", "rename"],
    ["outbox", "directory-fsync"],
    ["state", "temp-open"],
    ["state", "temp-write"],
    ["state", "temp-fsync"],
    ["state", "rename"],
    ["state", "directory-fsync"],
  ] as const)(
    "repairs exact acknowledgement identity after a hard exit at %s %s",
    async (area, boundary) => {
      const home = temporaryHome();
      await hardExitEnqueueAt(home, area, boundary, { ...input(), content: "safe" });

      const pending = await readPendingEvents({ home });
      expect(pending).toHaveLength(1);
      const event = pending[0]!.event;
      expect(event.type).toBe("turn.append");
      if (event.type !== "turn.append") throw new Error("Expected append event");
      await expect(
        acknowledgeEvent(
          event.host,
          event.clientInstanceId,
          event.hostSessionId,
          {
            type: event.type,
            eventId: event.eventId,
            enqueueSequence: event.enqueueSequence,
            sourceGeneration: event.sourceGeneration,
            hostMessageId: event.hostMessageId,
            role: event.role,
            contentHash: event.contentHash,
          },
          { home }
        )
      ).resolves.toMatchObject({ acknowledgedWatermark: 1 });
      await expect(
        enqueueVisibleMessage({ ...input(), hostMessageId: "message-2", content: "next" }, { home })
      ).resolves.toMatchObject({ event: { enqueueSequence: 2 } });
    }
  );

  it("orders outbox durability before state durability", async () => {
    const home = temporaryHome();
    await ensureSecureHarnessPaths({ home });
    const boundaries: string[] = [];
    await enqueueVisibleMessage(
      { ...input(), content: "safe" },
      {
        home,
        boundary: (boundary, path) => {
          const outbox = join(home, ".mnemo", "harness", "outbox");
          const state = join(home, ".mnemo", "harness", "state");
          const area =
            path === outbox || path.startsWith(`${outbox}/`)
              ? "outbox"
              : path === state || path.startsWith(`${state}/`)
                ? "state"
                : undefined;
          if (area === undefined) return;
          boundaries.push(`${area}:${boundary}`);
        },
      }
    );

    expect(boundaries).toEqual([
      "outbox:temp-open",
      "outbox:temp-write",
      "outbox:temp-fsync",
      "outbox:rename",
      "outbox:directory-fsync",
      "state:temp-open",
      "state:temp-write",
      "state:temp-fsync",
      "state:rename",
      "state:directory-fsync",
    ]);
  });

  it("allows only one concurrent replacement of the same unseen event", async () => {
    const home = temporaryHome();
    const original = await enqueueVisibleMessage({ ...input(), content: "safe" }, { home });
    const replacements = await Promise.allSettled([
      replaceUnseenWithLoss(original.event.eventId, "permanent_rejection", { home }),
      replaceUnseenWithLoss(original.event.eventId, "permanent_rejection", { home }),
    ]);

    expect(replacements.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(replacements.filter(({ status }) => status === "rejected")).toHaveLength(1);
  });

  it("splits >64 KiB UTF-8 messages into versioned transport chunks on code-point boundaries without truncation", async () => {
    const home = temporaryHome();
    const fullContent = `BEGIN-${"🦊".repeat(17_500)}-END`; // >70 KiB UTF-8
    expect(Buffer.byteLength(fullContent, "utf8")).toBeGreaterThan(HARNESS_MAX_MESSAGE_BYTES);

    const result = await enqueueVisibleMessage(
      { ...input("chunked-session", "large-msg-1"), role: "assistant", content: fullContent },
      { home }
    );
    expect(result.fullFidelity).toBe(true);
    expect(result.chunks).toHaveLength(2);

    const pending = await readPendingEvents({ home });
    expect(pending).toHaveLength(2);
    const fullHash = createHash("sha256").update(fullContent, "utf8").digest("hex");
    for (let idx = 0; idx < pending.length; idx += 1) {
      const ev = pending[idx]!.event;
      expect(ev.type).toBe("turn.append");
      if (ev.type === "turn.append") {
        expect(Buffer.byteLength(ev.content, "utf8")).toBeLessThanOrEqual(
          HARNESS_MAX_MESSAGE_BYTES
        );
        expect(ev.chunk).toEqual({
          version: 1,
          chunkIndex: idx,
          chunkCount: 2,
          messageContentHash: fullHash,
        });
      }
    }
    const reassembled = pending
      .map((p) => (p.event.type === "turn.append" ? p.event.content : ""))
      .join("");
    expect(reassembled).toBe(fullContent);
  });
});
