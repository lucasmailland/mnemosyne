/**
 * Test homes live under os.tmpdir(), never under the developer's real $HOME:
 * 24 `~/.mnemo-harness-test-*` directories had piled up there (APP-053).
 *
 * They were put there because turbo's strict env mode drops TMPDIR, tmpdir()
 * then falls back to world-writable /tmp, and the harness refuses a HOME under
 * it. `vitest.tmpdir.ts` hands the workers the private per-user temp dir
 * instead, which is what the second test proves.
 */
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ensureSecureHarnessPaths } from "../fs-security.js";

const PACKAGES = join(import.meta.dirname, "..", "..", "..");
const IN_REAL_HOME =
  /mkdtemp(?:Sync)?\(\s*join\(\s*(?:homedir\(\)|process\.env\.MNEMO_TEST_REAL_HOME)/;

describe("test temp directories", () => {
  it("are never made under the real home", () => {
    const files = ["harness/src", "cli/src"].flatMap((dir) =>
      readdirSync(join(PACKAGES, dir), { recursive: true, encoding: "utf8" })
        .filter((file) => file.includes("__tests__") && file.endsWith(".ts"))
        .map((file) => join(dir, file))
    );
    expect(files.length).toBeGreaterThan(20);
    expect(
      files.filter((file) => IN_REAL_HOME.test(readFileSync(join(PACKAGES, file), "utf8")))
    ).toEqual([]);
  });

  it("can root a harness HOME under tmpdir()", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "mnemo-harness-tmpdir-")));
    try {
      await expect(ensureSecureHarnessPaths({ home })).resolves.toMatchObject({ home });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
