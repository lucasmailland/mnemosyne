import { lstat, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const reclaim = vi.hoisted(() => ({
  beforeRename: undefined as (() => Promise<void>) | undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    rename: async (from: string, to: string) => {
      if (from.endsWith(".excl") && to.endsWith(".stale")) await reclaim.beforeRename?.();
      return fs.rename(from, to);
    },
  };
});
import { ensureSecureHarnessPaths, withExclusiveFileLock } from "../fs-security.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const roots: string[] = [];
afterEach(async () => {
  reclaim.beforeRename = undefined;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function paths() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "mnemo-lock-test-")));
  roots.push(home);
  return ensureSecureHarnessPaths({ home });
}
async function independentLocker() {
  // Separate module state models separate hook processes: no shared local tail.
  vi.resetModules();
  return (await import("../fs-security.js")).withExclusiveFileLock;
}

it("coordinates stale recovery with acquisition before removing the observed lock", async () => {
  const dirs = await paths();
  await writeFile(
    join(dirs.locks, "race.excl"),
    JSON.stringify({
      pid: 2 ** 22 + 12345,
      token: "dead",
      acquiredAt: Date.now(), // determinism-ok: a fresh lock, so recovery must come from the dead pid, not its age
    }),
    { mode: 0o600 }
  );
  const observed = deferred(),
    resume = deferred();
  let paused = false;
  reclaim.beforeRename = async () => {
    if (paused) return;
    paused = true;
    observed.resolve();
    await resume.promise;
  };
  const other = await independentLocker();
  const entered = deferred(),
    release = deferred();
  const first = withExclusiveFileLock(dirs, "race", async () => {
    entered.resolve();
    await release.promise;
  });
  await observed.promise;
  try {
    await expect(other(dirs, "race", async () => undefined, { waitMs: 100 })).rejects.toThrow(
      /Timed out/
    );
  } finally {
    resume.resolve();
    await entered.promise;
    try {
      // A third contender must not enter while the reclaimed lock's new owner
      // is inside its operation, even after the stale observer has timed out.
      await expect(other(dirs, "race", async () => undefined, { waitMs: 30 })).rejects.toThrow(
        /Timed out/
      );
    } finally {
      release.resolve();
    }
    await first;
  }
  await expect(other(dirs, "race", async () => "acquired")).resolves.toBe("acquired");
});

it("never evicts a live operation just because staleMs elapsed", async () => {
  const dirs = await paths();
  const entered = deferred(),
    release = deferred();
  const other = await independentLocker();
  const first = withExclusiveFileLock(dirs, "live", async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  await new Promise((done) => setTimeout(done, 10));
  try {
    await expect(
      other(dirs, "live", async () => undefined, { staleMs: 1, waitMs: 30 })
    ).rejects.toThrow(/Timed out/);
  } finally {
    release.resolve();
    await first;
  }
});

it("recovers a crashed contender without reusing its ticket pathname", async () => {
  const dirs = await paths();
  const abandoned = join(dirs.locks, "crashed.4216649.11111111-1111-4111-8111-111111111111.ticket");
  await writeFile(abandoned, "", { mode: 0o600 });
  await expect(withExclusiveFileLock(dirs, "crashed", async () => "acquired")).resolves.toBe(
    "acquired"
  );
  await expect(lstat(abandoned)).rejects.toMatchObject({ code: "ENOENT" });
});
