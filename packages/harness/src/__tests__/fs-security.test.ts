import { spawn } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  existsSync,
  readdirSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

// Some cases spawn tsx children that SIGKILL themselves mid-write; a cold
// start under a full parallel sweep took past the 5 s default (5.2 s seen).
vi.setConfig({ testTimeout: 30_000 });
import {
  assertSecureRegularFile,
  assertSafePathComponent,
  ensureSecureHarnessPaths,
  inspectFilesystemCapabilities,
  withAdvisoryLock,
  recoverAtomicTemporaryFiles,
} from "../fs-security.js";

const roots: string[] = [];
const sourceRoot = fileURLToPath(new URL("..", import.meta.url));
const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");

function temporaryHome(): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "mnemo-harness-test-")));
  roots.push(home);
  return home;
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("secure harness filesystem", () => {
  it("syncs every managed directory parent before returning new storage", async () => {
    const home = temporaryHome();
    const synced: string[] = [];
    const paths = await ensureSecureHarnessPaths({
      home,
      boundary: (boundary, path) => {
        if (boundary === "directory-fsync") synced.push(path);
      },
    });
    expect(synced).toContain(home);
    expect(synced).toContain(paths.mnemoRoot);
    // One fsync of the root per managed directory under it. Derived rather than
    // hardcoded: the property is "every one of them", not "five of them".
    const managed = [
      paths.outbox,
      paths.state,
      paths.capture,
      paths.locks,
      paths.quarantine,
      paths.audit,
    ];
    expect(managed.every((path) => dirname(path) === paths.root)).toBe(true);
    expect(synced.filter((path) => path === paths.root)).toHaveLength(managed.length);
  });

  it("resyncs managed directory parents after an interrupted prior initialization", async () => {
    const home = temporaryHome();
    const root = join(home, ".mnemo", "harness");
    for (const path of [
      join(home, ".mnemo"),
      root,
      join(root, "outbox"),
      join(root, "state"),
      join(root, "capture"),
      join(root, "locks"),
      join(root, "quarantine"),
      join(root, "audit"),
    ])
      mkdirSync(path, { mode: 0o700 });
    const synced: string[] = [];

    await ensureSecureHarnessPaths({
      home,
      boundary: (boundary, path) => {
        if (boundary === "directory-fsync") synced.push(path);
      },
    });

    expect(synced).toContain(home);
    expect(synced).toContain(join(home, ".mnemo"));
    expect(synced.filter((path) => path === root)).toHaveLength(6);
  });

  it("preserves temporary evidence if degradation cannot be persisted", async () => {
    const paths = await ensureSecureHarnessPaths({ home: temporaryHome() });
    const temporary = join(paths.outbox, ".event.json.11111111-1111-4111-8111-111111111111.tmp");
    writeFileSync(temporary, "uncommitted", { mode: 0o600 });
    await expect(
      recoverAtomicTemporaryFiles([paths.outbox], undefined, {
        beforeDiscard: async () => {
          throw new Error("latch failed");
        },
      })
    ).rejects.toThrow("latch failed");
    expect(existsSync(temporary)).toBe(true);
  });

  it("keeps a durable degradation latch after hard exit during temporary recovery", async () => {
    const paths = await ensureSecureHarnessPaths({ home: temporaryHome() });
    const temporary = join(paths.outbox, ".event.json.11111111-1111-4111-8111-111111111111.tmp");
    writeFileSync(temporary, "uncommitted", { mode: 0o600 });
    const script = [
      `import { ensureSecureHarnessPaths, recoverAtomicTemporaryFiles, writeFidelityFailureLatch } from ${JSON.stringify(join(sourceRoot, "fs-security.ts"))};`,
      `(async () => {`,
      `const paths = await ensureSecureHarnessPaths({home: process.argv[1]});`,
      `await recoverAtomicTemporaryFiles([paths.outbox], undefined, {`,
      `beforeDiscard: () => writeFidelityFailureLatch(paths, "uncommitted_temporary_file"),`,
      `boundary: (boundary) => { if (boundary === "temporary-unlink") process.kill(process.pid, "SIGKILL"); },`,
      `}); })().catch(e => {console.error(e); process.exit(1);});`,
    ].join("\n");
    const child = spawn(process.execPath, [tsxCli, "--eval", script, paths.home], {
      stdio: "ignore",
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve(signal === "SIGKILL" ? 137 : code));
    });
    expect(code).toBe(137);
    expect(existsSync(temporary)).toBe(false);
    expect(existsSync(join(paths.state, "full-fidelity.json"))).toBe(true);
  });

  it("does not starve filesystem I/O with same-process lock contenders", async () => {
    const home = temporaryHome();
    const script = [
      `import { ensureSecureHarnessPaths, withAdvisoryLock, readPrivateFile } from ${JSON.stringify(join(sourceRoot, "fs-security.ts"))};`,
      `(async () => {`,
      `const paths = await ensureSecureHarnessPaths({home: process.argv[1]});`,
      `let active = 0;`,
      `await Promise.all(Array.from({length: 8}, () => withAdvisoryLock(paths, "contended", async () => {`,
      `if (++active !== 1) throw new Error("overlap");`,
      `await readPrivateFile(paths.locks + "/contended.lock"); active--;`,
      `}))); process.exit(0);`,
      `})().catch(e => {console.error(e); process.exit(1);});`,
    ].join("\n");
    const child = spawn(process.execPath, [tsxCli, "--eval", script, home], {
      stdio: "ignore",
      env: { ...process.env, UV_THREADPOOL_SIZE: "2" },
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      const timeout = setTimeout(() => child.kill("SIGKILL"), 4_000);
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timeout);
        resolve(code);
      });
    });
    expect(code).toBe(0);
  });

  it("rejects same-context lock reentry instead of deadlocking", async () => {
    const paths = await ensureSecureHarnessPaths({ home: temporaryHome() });

    await expect(
      withAdvisoryLock(paths, "nested", () =>
        withAdvisoryLock(paths, "nested", async () => undefined)
      )
    ).rejects.toThrow(/reentrant|already held/i);
  });

  it("creates every managed directory as 0700 and lock files as 0600", async () => {
    const paths = await ensureSecureHarnessPaths({ home: temporaryHome() });

    for (const path of [
      paths.mnemoRoot,
      paths.root,
      paths.outbox,
      paths.state,
      paths.locks,
      paths.quarantine,
      paths.audit,
    ]) {
      expect(lstatSync(path).mode & 0o777).toBe(0o700);
      expect(lstatSync(path).uid).toBe(process.getuid?.());
    }

    await withAdvisoryLock(paths, "session-safe", async () => undefined);
    const lock = join(paths.locks, "session-safe.lock");
    expect(lstatSync(lock).mode & 0o777).toBe(0o600);
    expect(lstatSync(lock).isFile()).toBe(true);
  });

  it("rejects unsafe existing paths instead of chmod-repairing them", async () => {
    const home = temporaryHome();
    const root = join(home, ".mnemo");
    mkdirSync(root, { mode: 0o755 });

    await expect(ensureSecureHarnessPaths({ home })).rejects.toThrow(/mode.*0700/i);
    expect(lstatSync(root).mode & 0o777).toBe(0o755);
  });

  it("rejects a writable ancestor before creating managed storage", async () => {
    const home = temporaryHome();
    chmodSync(home, 0o770);

    await expect(ensureSecureHarnessPaths({ home })).rejects.toThrow(/writable ancestor/i);
    expect(() => lstatSync(join(home, ".mnemo"))).toThrow();
  });

  it("rejects managed root identities changed before acquiring a lock", async () => {
    const paths = await ensureSecureHarnessPaths({ home: temporaryHome() });
    renameSync(paths.root, `${paths.root}.replaced`);
    mkdirSync(paths.root, { mode: 0o700 });
    for (const name of ["outbox", "state", "locks", "quarantine", "audit"]) {
      mkdirSync(join(paths.root, name), { mode: 0o700 });
    }

    await expect(withAdvisoryLock(paths, "ancestor-swap", async () => undefined)).rejects.toThrow(
      /identity changed/i
    );
  });

  it("revalidates managed root identities immediately after flock acquisition", async () => {
    const paths = await ensureSecureHarnessPaths({ home: temporaryHome() });
    const fsExt = createRequire(import.meta.url)("fs-ext") as {
      flock: (
        fd: number,
        operation: string,
        callback: (error: NodeJS.ErrnoException | null) => void
      ) => void;
    };
    const originalFlock = fsExt.flock;
    let replaced = false;
    fsExt.flock = (fd, operation, callback) =>
      originalFlock(fd, operation, (error) => {
        if (error === null && operation === "ex" && !replaced) {
          replaced = true;
          renameSync(paths.root, `${paths.root}.replaced`);
          mkdirSync(paths.root, { mode: 0o700 });
          for (const name of ["outbox", "state", "locks", "quarantine", "audit"])
            mkdirSync(join(paths.root, name), { mode: 0o700 });
        }
        callback(error);
      });
    try {
      await expect(
        withAdvisoryLock(paths, "post-acquisition", async () => undefined)
      ).rejects.toThrow(/identity changed/i);
    } finally {
      fsExt.flock = originalFlock;
    }
  });

  it("revalidates every ancestor even when the HOME subtree keeps its inode", async () => {
    const outer = temporaryHome();
    const ancestor = join(outer, "ancestor");
    const home = join(ancestor, "home");
    mkdirSync(ancestor, { mode: 0o700 });
    mkdirSync(home, { mode: 0o700 });
    const paths = await ensureSecureHarnessPaths({ home });
    renameSync(ancestor, `${ancestor}.moved`);
    symlinkSync(`${ancestor}.moved`, ancestor);

    await expect(withAdvisoryLock(paths, "ancestor-chain", async () => undefined)).rejects.toThrow(
      /identity changed|unsafe ancestor/i
    );
  });

  it("rejects symlinks, non-regular files, and traversal components", async () => {
    const home = temporaryHome();
    const target = join(home, "target");
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, join(home, ".mnemo"));

    await expect(ensureSecureHarnessPaths({ home })).rejects.toThrow(/symlink/i);
    expect(() => assertSafePathComponent("../escape")).toThrow(/component/i);
    expect(() => assertSafePathComponent("nested/name")).toThrow(/component/i);
  });

  it("rejects an unsafe existing lock file without changing it", async () => {
    const paths = await ensureSecureHarnessPaths({ home: temporaryHome() });
    const lock = join(paths.locks, "unsafe.lock");
    writeFileSync(lock, "", { mode: 0o644 });
    chmodSync(lock, 0o644);

    await expect(withAdvisoryLock(paths, "unsafe", async () => undefined)).rejects.toThrow(
      /mode.*0600/i
    );
    expect(lstatSync(lock).mode & 0o777).toBe(0o644);
  });

  it("rejects an existing file owned by another uid", async () => {
    const paths = await ensureSecureHarnessPaths({ home: temporaryHome() });
    const file = join(paths.state, "wrong-owner.json");
    writeFileSync(file, "{}", { mode: 0o600 });
    const uid = process.getuid?.();
    if (uid === undefined) return;
    const getuid = vi.spyOn(process, "getuid").mockReturnValue(uid + 1);
    try {
      await expect(assertSecureRegularFile(file)).rejects.toThrow(/owner/i);
    } finally {
      getuid.mockRestore();
    }
  });

  it("probes real no-follow, flock, ownership, and file/directory fsync operations", async () => {
    const home = temporaryHome();
    const result = await inspectFilesystemCapabilities({ home });

    expect(result).toMatchObject({
      mode: "available",
      noFollow: true,
      advisoryLock: true,
      lockExclusion: true,
      fileFsync: true,
      directoryFsync: true,
      ownership: true,
    });
    expect(result.reasons).toEqual([]);
    expect(readdirSync(home).filter((name) => name.startsWith(".mnemo-harness-probe-"))).toEqual(
      []
    );
  });

  it("rechecks managed-root policy after the locked operation boundary", async () => {
    const paths = await ensureSecureHarnessPaths({ home: temporaryHome() });

    await expect(
      withAdvisoryLock(paths, "operation-boundary", async () => {
        chmodSync(paths.root, 0o755);
      })
    ).rejects.toThrow(/mode|policy|identity/i);
  });

  it("reports unavailable instead of emulating missing required primitives", async () => {
    const home = temporaryHome();
    expect(
      await inspectFilesystemCapabilities({ home, forceUnavailable: "nofollow" })
    ).toMatchObject({
      mode: "unavailable",
      noFollow: false,
    });
    expect(await inspectFilesystemCapabilities({ home, forceUnavailable: "flock" })).toMatchObject({
      mode: "unavailable",
      advisoryLock: false,
    });
  });

  it("lets the OS release an advisory lock when a child process dies", async () => {
    const paths = await ensureSecureHarnessPaths({ home: temporaryHome() });
    const childScript = [
      `import { ensureSecureHarnessPaths, withAdvisoryLock } from ${JSON.stringify(join(sourceRoot, "fs-security.ts"))};`,
      `(async () => {`,
      `const paths = await ensureSecureHarnessPaths({ home: ${JSON.stringify(paths.home)} });`,
      `await withAdvisoryLock(paths, "crash", async () => { process.stdout.write("locked\\n"); await new Promise(() => {}); });`,
      `})().catch((error) => { console.error(error); process.exit(1); });`,
    ].join("\n");
    const child = spawn(process.execPath, [tsxCli, "--eval", childScript], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise<void>((resolve, reject) => {
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += String(chunk);
        if (output.includes("locked\n")) resolve();
      });
      child.once("error", reject);
      child.stderr.once("data", (chunk) => reject(new Error(String(chunk))));
    });
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));

    await expect(withAdvisoryLock(paths, "crash", async () => "acquired")).resolves.toBe(
      "acquired"
    );
  });
});
