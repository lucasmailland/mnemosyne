/**
 * The harness the CLI ships (scripts/copy-harness.cjs, run after tsup) must
 * resolve host capture exactly as the harness package does.
 *
 * Bundled into index.js, it could not find its own package root, qualification
 * records or fixtures, and every host fell to mcp-only ("harness package root
 * not found") in an npm install. The copy is imported the same way the built
 * CLI imports it, from a temp dir standing in for dist/harness.
 */
import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const CLI = join(import.meta.dirname, "..", "..");
const PACKAGES = join(CLI, "..");
const out = join(mkdtempSync(join(tmpdir(), "mnemo-cli-harness-")), "harness");
const qualified = join(out, "..", "stamped-qualifications");

afterAll(() => rmSync(join(out, ".."), { recursive: true, force: true }));

type Harness = typeof import("@mnemo-ai/harness");
const load = (dir: string): Promise<Harness> =>
  import(pathToFileURL(join(dir, "dist", "index.js")).href) as Promise<Harness>;

describe("the CLI's copy of the harness", () => {
  it("decides each host's capture mode like the harness package itself", async () => {
    execFileSync(process.execPath, [join(CLI, "scripts", "copy-harness.cjs"), out], {
      stdio: "ignore",
    });
    const [copy, original] = await Promise.all([load(out), load(join(PACKAGES, "harness"))]);
    const artifactRoot = join(PACKAGES, "plugin");

    for (const host of ["claude-code", "codex", "opencode"] as const) {
      // The machine the record was made on, so the answer does not depend on this one.
      const record = JSON.parse(
        readFileSync(join(out, "qualifications", `${host}.json`), "utf8")
      ) as { hostVersion: string; platform: string; mode: string; packageHash: string };
      const input = {
        host,
        hostVersion: record.hostVersion,
        artifactRoot,
        platform: record.platform,
      };
      const fromCopy = copy.resolveHostCaptureMode(input);
      expect(fromCopy.reason).not.toMatch(/package root|dist is missing/);
      expect(fromCopy).toEqual(original.resolveHostCaptureMode(input));
      const hash = copy.computeCaptureArtifactHash({ host, artifactRoot });
      if (!("hash" in hash)) throw new Error(hash.error);
      // Whether the checked-in record is fresh is not this test's question: a
      // stale one is a release blocker (`qualify-harness-host.mjs validate-all`,
      // docs/RELEASING.md), never an outcome to accept. Here a record stamped
      // with this build's hash proves the copy GRANTS the qualified mode.
      const stamped = join(qualified, host);
      mkdirSync(stamped, { recursive: true });
      writeFileSync(
        join(stamped, `${host}.json`),
        JSON.stringify({ ...record, packageHash: hash.hash })
      );
      const dirs = { qualificationsDir: stamped, fixturesDir: join(out, "fixtures") };
      expect(copy.resolveHostCaptureMode({ ...input, ...dirs })).toMatchObject({
        mode: record.mode,
      });
      expect(original.resolveHostCaptureMode({ ...input, ...dirs })).toMatchObject({
        mode: record.mode,
      });
      expect(copy.computeCaptureArtifactHash({ host, artifactRoot })).toEqual(
        original.computeCaptureArtifactHash({ host, artifactRoot })
      );
    }
  });
});
