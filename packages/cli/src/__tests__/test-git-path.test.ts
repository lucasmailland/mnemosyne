/**
 * macOS's /usr/bin/git is an xcrun shim that spends 1-4 s (more under load) the
 * first time it runs under a HOME it has not seen, and vitest.setup.ts gives
 * every test file a fresh HOME. That alone pushed `detectProjectName returns
 * basename(cwd)…` past its 5 s budget in full runs (APP-045). The setup puts the
 * real binary ahead of the shim; this holds it there.
 */
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { expect, it } from "vitest";

it.runIf(process.platform === "darwin")("tests spawn the real git, not the xcrun shim", () => {
  const first = (process.env.PATH ?? "")
    .split(delimiter)
    .find((dir) => existsSync(join(dir, "git")));
  expect(first).toBeDefined();
  expect(join(first!, "git")).not.toBe("/usr/bin/git");
});
