/**
 * The marker is the only thing standing between "artifacts installed" and "your
 * conversations are being captured", so its failure direction is the whole point:
 * anything it cannot read is OFF.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { clearCaptureConsent, readCaptureConsent, writeCaptureConsent } from "../consent.js";
import { ensureSecureHarnessPaths } from "../fs-security.js";

const roots: string[] = [];

function temporaryHome(): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "mnemo-harness-test-")));
  roots.push(home);
  return home;
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const INPUT = {
  host: "claude-code",
  mode: "user-only",
  hostVersion: "2.1.267",
  packageHash: "a".repeat(64),
} as const;

describe("recording that the user turned capture on", () => {
  it("round-trips a marker for one host", async () => {
    const home = temporaryHome();
    const written = await writeCaptureConsent(INPUT, { home });

    expect(written).toMatchObject({ version: 1, host: "claude-code", mode: "user-only" });
    expect(Date.parse(written.consentedAt)).not.toBeNaN();
    await expect(readCaptureConsent("claude-code", { home })).resolves.toEqual(written);
  });

  it("keeps one host's consent from enabling another", async () => {
    const home = temporaryHome();
    await writeCaptureConsent(INPUT, { home });

    // Consenting to capture Claude Code is not consenting to capture Codex.
    await expect(readCaptureConsent("codex", { home })).resolves.toBeNull();
    await expect(readCaptureConsent("opencode", { home })).resolves.toBeNull();
  });

  it("writes the marker 0600, like every other harness file", async () => {
    const home = temporaryHome();
    await writeCaptureConsent(INPUT, { home });
    const paths = await ensureSecureHarnessPaths({ home });

    expect(statSync(join(paths.capture, "claude-code.json")).mode & 0o777).toBe(0o600);
    expect(statSync(paths.capture).mode & 0o777).toBe(0o700);
  });

  it("replaces an earlier consent rather than accumulating markers", async () => {
    const home = temporaryHome();
    const first = await writeCaptureConsent(
      { ...INPUT, consentedAt: "2026-01-01T00:00:00.000Z" },
      { home }
    );
    const second = await writeCaptureConsent({ ...INPUT, mode: "full" }, { home });

    expect(first.mode).toBe("user-only");
    await expect(readCaptureConsent("claude-code", { home })).resolves.toEqual(second);
  });
});

describe("a gate that cannot read its evidence reads as off", () => {
  it("returns null when no marker was ever written", async () => {
    const home = temporaryHome();
    await expect(readCaptureConsent("claude-code", { home })).resolves.toBeNull();
  });

  it("returns null for a malformed marker rather than throwing", async () => {
    const home = temporaryHome();
    const paths = await ensureSecureHarnessPaths({ home });
    writeFileSync(join(paths.capture, "codex.json"), "{ not json", { mode: 0o600 });

    await expect(readCaptureConsent("codex", { home })).resolves.toBeNull();
  });

  it("returns null for a marker from a version this build does not understand", async () => {
    const home = temporaryHome();
    const paths = await ensureSecureHarnessPaths({ home });
    writeFileSync(
      join(paths.capture, "codex.json"),
      JSON.stringify({ version: 2, host: "codex" }),
      {
        mode: 0o600,
      }
    );

    await expect(readCaptureConsent("codex", { home })).resolves.toBeNull();
  });
});

describe("revoking consent", () => {
  it("removes the marker and reports that it did", async () => {
    const home = temporaryHome();
    await writeCaptureConsent(INPUT, { home });

    await expect(clearCaptureConsent("claude-code", { home })).resolves.toBe(true);
    await expect(readCaptureConsent("claude-code", { home })).resolves.toBeNull();
  });

  it("treats clearing an absent marker as success, not an error", async () => {
    const home = temporaryHome();
    // The caller asked for capture to be off. It is off.
    await expect(clearCaptureConsent("opencode", { home })).resolves.toBe(false);
  });

  it("revokes exactly one host", async () => {
    const home = temporaryHome();
    await writeCaptureConsent(INPUT, { home });
    await writeCaptureConsent({ ...INPUT, host: "codex", mode: "mcp-only" }, { home });

    await clearCaptureConsent("claude-code", { home });

    await expect(readCaptureConsent("claude-code", { home })).resolves.toBeNull();
    await expect(readCaptureConsent("codex", { home })).resolves.toMatchObject({ host: "codex" });
  });
});
