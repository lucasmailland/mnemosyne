// Pin the locale so a developer shell (e.g. LANG=es_AR.UTF-8) cannot change test output.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { afterAll } from "vitest";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

process.env.LANG = "C";
delete process.env.LC_ALL;
delete process.env.LC_MESSAGES;
delete process.env.MNEMO_LOCALE;

// macOS's /usr/bin/git is an xcrun shim that spends 1-4 s (more under load) the first time it
// runs under a HOME it has not seen, and every file gets a fresh HOME below: that alone pushed
// `detectProjectName…` past its 5 s budget in full runs. Put the real binary first on PATH,
// resolved before HOME changes, while the shim's lookup is still cached.
const firstGitDir = process.env.PATH?.split(delimiter).find((dir) => existsSync(join(dir, "git")));
const realGit =
  firstGitDir === "/usr/bin" ? spawnSync("xcrun", ["--find", "git"], { encoding: "utf8" }) : null;
const tempDirs: string[] = [];
if (realGit?.status === 0) {
  const bin = mkdtempSync(join(tmpdir(), "mnemo-test-bin-"));
  tempDirs.push(bin);
  symlinkSync(realGit.stdout.trim(), join(bin, "git"));
  process.env.PATH = `${bin}${delimiter}${process.env.PATH}`;
}

// ...and so can the developer's ~/.mnemo/config.json (`locale`): every test process gets a
// fresh, empty home. Tests that need a config set their own HOME. tmpdir() is the private
// per-user temp dir (vitest.config.ts), so the harness accepts homes made under it.
const home = mkdtempSync(join(tmpdir(), "mnemo-test-home-"));
tempDirs.push(home);
process.env.HOME = home;
process.env.USERPROFILE = home;
// One per test file: removed once the file's tests are done.
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});
