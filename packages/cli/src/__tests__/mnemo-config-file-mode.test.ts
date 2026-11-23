/**
 * Re-audit 2, item 2 (APP-038 residual): `mnemo init` wrote ~/.mnemo/config.json,
 * which holds the API key, with the default umask (usually 0644) in a
 * directory created without 0700; `mnemo login` already used 0700/0600.
 */
import { mkdtempSync, rmSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeMnemoConfigFile } from "../commands.js";

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("writeMnemoConfigFile", () => {
  it("writes the key file 0600 in a 0700 directory, even under a permissive umask", () => {
    dir = mkdtempSync(join(tmpdir(), "mnemo-cfg-"));
    const configDir = join(dir, ".mnemo");
    const old = process.umask(0o022);
    try {
      writeMnemoConfigFile(configDir, { url: "http://localhost:3939", apiKey: "mns_live_x" });
    } finally {
      process.umask(old);
    }
    expect(statSync(configDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(configDir, "config.json")).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(configDir, "config.json"), "utf8")).apiKey).toBe(
      "mns_live_x"
    );
  });
});
