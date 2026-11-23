import {
  close as closeCallback,
  constants,
  fstat as fstatCallback,
  fsync as fsyncCallback,
  open as openCallback,
  readFile as readFileCallback,
  writeFile as writeFileCallback,
} from "node:fs";
import {
  lstat,
  mkdir,
  open as openPromise,
  readdir,
  realpath,
  rename,
  rmdir,
  symlink,
  unlink,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, resolve } from "node:path";
import { promisify } from "node:util";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { canonicalJson } from "@mnemo-ai/types/harness-runtime";

const require = createRequire(import.meta.url);
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const NO_FOLLOW = constants.O_NOFOLLOW;
const openDescriptor = promisify(openCallback);
const closeDescriptor = promisify(closeCallback);
const fsyncDescriptor = promisify(fsyncCallback);
const fstatDescriptor = promisify(fstatCallback);
const readDescriptor = promisify(readFileCallback);
const writeDescriptor = promisify(writeFileCallback);
const localLockTails = new Map<string, Promise<void>>();
const heldLocalLocks = new AsyncLocalStorage<ReadonlySet<string>>();

export interface HarnessPaths {
  home: string;
  mnemoRoot: string;
  root: string;
  outbox: string;
  state: string;
  /**
   * Per-host capture consent markers.
   *
   * A SIBLING of `state`, not a directory inside it: every managed directory here
   * holds regular files only, and `listSecureRegularFiles` refuses a subdirectory
   * on sight. Nesting these would have traded that invariant for a tidier path.
   */
  capture: string;
  locks: string;
  quarantine: string;
  audit: string;
  /** Internal identity snapshot used to detect path replacement while locks are held. */
  identities: Readonly<Record<string, FilesystemIdentity>>;
}

export interface FilesystemIdentity {
  dev: number;
  ino: number;
}

export interface FilesystemCapabilities {
  mode: "available" | "degraded" | "unavailable";
  noFollow: boolean;
  advisoryLock: boolean;
  lockExclusion: boolean;
  fileFsync: boolean;
  directoryFsync: boolean;
  ownership: boolean;
  reasons: string[];
}

export type PersistenceBoundary =
  "temp-open" | "temp-write" | "temp-fsync" | "rename" | "directory-fsync" | "temporary-unlink";

export interface AtomicWriteOptions {
  boundary?: (boundary: PersistenceBoundary, path: string) => void | Promise<void>;
}

export interface TemporaryRecoveryOptions extends AtomicWriteOptions {
  beforeDiscard?: (path: string) => void | Promise<void>;
}

export type FidelityFailureReason =
  | "capture_loss"
  | "loss_persistence_failed"
  | "malformed_pending_event"
  | "uncommitted_temporary_file";

interface FsExtModule {
  flock(
    fd: number,
    operation: string,
    callback: (error?: NodeJS.ErrnoException | null) => void
  ): void;
}

function currentUid(): number {
  if (process.getuid === undefined) throw new Error("Filesystem ownership checks are unavailable");
  return process.getuid();
}

function loadFsExt(): FsExtModule | null {
  try {
    return require("fs-ext") as FsExtModule;
  } catch {
    return null;
  }
}

function modeOf(mode: number): number {
  return mode & 0o777;
}

function identityOf(info: { dev: number; ino: number }): FilesystemIdentity {
  return { dev: info.dev, ino: info.ino };
}

function sameIdentity(left: FilesystemIdentity, right: FilesystemIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function pathAncestors(path: string): string[] {
  const root = parse(path).root;
  const result: string[] = [];
  let current = path;
  while (true) {
    result.push(current);
    if (current === root) break;
    current = dirname(current);
  }
  return result.reverse();
}

async function assertSafeAncestorChain(path: string): Promise<void> {
  const uid = currentUid();
  for (const ancestor of pathAncestors(path)) {
    const info = await lstat(ancestor);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`Unsafe ancestor path: ${ancestor}`);
    }
    if (info.uid !== uid && info.uid !== 0) {
      throw new Error(`Unsafe owner for ancestor: ${ancestor}`);
    }
    if ((modeOf(info.mode) & 0o022) !== 0) {
      throw new Error(`Unsafe writable ancestor: ${ancestor}`);
    }
  }
}

async function assertOwnedDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error(`Unsafe symlink directory: ${path}`);
  if (!info.isDirectory()) throw new Error(`Unsafe non-directory path: ${path}`);
  if (info.uid !== currentUid()) throw new Error(`Unsafe owner for directory: ${path}`);
  if (modeOf(info.mode) !== DIRECTORY_MODE) {
    throw new Error(`Unsafe directory mode for ${path}; expected 0700`);
  }
}

async function assertOwnedBaseDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error(`Unsafe symlink directory: ${path}`);
  if (!info.isDirectory()) throw new Error(`Unsafe non-directory path: ${path}`);
  if (info.uid !== currentUid()) throw new Error(`Unsafe owner for directory: ${path}`);
  if ((modeOf(info.mode) & 0o022) !== 0) throw new Error(`Unsafe writable ancestor: ${path}`);
}

function ifMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function ensureOwnedDirectory(path: string): Promise<boolean> {
  try {
    await assertOwnedDirectory(path);
    return false;
  } catch (error) {
    if (!ifMissing(error)) throw error;
  }

  try {
    await mkdir(path, { mode: DIRECTORY_MODE });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await assertOwnedDirectory(path);
  return true;
}

export function assertSafePathComponent(component: string): void {
  if (
    component.length === 0 ||
    component === "." ||
    component === ".." ||
    component.includes("/") ||
    component.includes("\\") ||
    component.includes("\0") ||
    basename(component) !== component
  ) {
    throw new Error("Unsafe filesystem path component");
  }
}

export function sessionLockName(sessionKey: string): string {
  if (!/^[0-9a-f]{64}$/.test(sessionKey)) throw new Error("Invalid source session key");
  return `session-${Number.parseInt(sessionKey.slice(0, 2), 16) % 32}`;
}

export async function inspectFilesystemCapabilities(
  options: {
    forceUnavailable?: "nofollow" | "flock";
    home?: string;
  } = {}
): Promise<FilesystemCapabilities> {
  let noFollow = options.forceUnavailable !== "nofollow" && typeof NO_FOLLOW === "number";
  let advisoryLock = options.forceUnavailable !== "flock" && loadFsExt() !== null;
  let lockExclusion = false;
  let fileFsync = false;
  let directoryFsync = false;
  let ownership = false;
  const reasons: string[] = [];
  let probeDirectory: string | undefined;
  let probeFile: string | undefined;
  let probeLink: string | undefined;
  let probeHome: string | undefined;
  let cleanupFailed = false;
  try {
    const suppliedHome = options.home ?? homedir();
    if (!isAbsolute(suppliedHome)) throw new Error("Harness HOME must be absolute");
    const home = resolve(suppliedHome);
    probeHome = home;
    if ((await realpath(home)) !== home) throw new Error("Harness HOME must be canonical");
    await assertSafeAncestorChain(home);
    await assertOwnedBaseDirectory(home);
    probeDirectory = join(home, `.mnemo-harness-probe-${randomUUID()}`);
    await mkdir(probeDirectory, { mode: DIRECTORY_MODE });
    await assertOwnedDirectory(probeDirectory);
    ownership = true;

    if (!noFollow) throw new Error("O_NOFOLLOW is unavailable");
    probeFile = join(probeDirectory, "probe");
    const fd = await secureOpenFile(
      probeFile,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL
    );
    try {
      await writeDescriptor(fd, "probe");
      await fsyncDescriptor(fd);
      fileFsync = true;
      probeLink = join(probeDirectory, "probe-link");
      await symlink(probeFile, probeLink);
      let followed = false;
      try {
        const followedFd = await openDescriptor(probeLink, constants.O_RDONLY | NO_FOLLOW);
        followed = true;
        await closeDescriptor(followedFd);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ELOOP") throw error;
      }
      if (followed) throw new Error("O_NOFOLLOW followed a temporary symlink");
      if (!advisoryLock) throw new Error("fs-ext advisory flock is unavailable");
      const flock = promisify(loadFsExt()!.flock);
      await flock(fd, "ex");
      await probeCompetingFlock(probeFile, true);
      await flock(fd, "un");
      await probeCompetingFlock(probeFile, false);
      lockExclusion = true;
    } finally {
      await closeDescriptor(fd);
    }
    await fsyncDirectory(probeDirectory);
    directoryFsync = true;
    await unlink(probeFile);
    await fsyncDirectory(probeDirectory);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    reasons.push(message);
    if (message.includes("O_NOFOLLOW")) noFollow = false;
    if (message.includes("flock")) advisoryLock = false;
  } finally {
    try {
      if (probeLink !== undefined) await unlink(probeLink).catch(ignoreMissing);
      if (probeFile !== undefined) await unlink(probeFile).catch(ignoreMissing);
      if (probeDirectory !== undefined) await rmdir(probeDirectory).catch(ignoreMissing);
      if (probeHome !== undefined && noFollow) await fsyncBaseDirectory(probeHome);
    } catch (error) {
      cleanupFailed = true;
      reasons.push(`Capability probe cleanup failed: ${String(error)}`);
    }
  }
  if (!noFollow && !reasons.some((reason) => reason.includes("O_NOFOLLOW")))
    reasons.push("O_NOFOLLOW is unavailable");
  if (!advisoryLock && !reasons.some((reason) => reason.includes("flock")))
    reasons.push("fs-ext advisory flock is unavailable");
  return {
    mode:
      noFollow &&
      advisoryLock &&
      lockExclusion &&
      fileFsync &&
      directoryFsync &&
      ownership &&
      !cleanupFailed
        ? "available"
        : "unavailable",
    noFollow,
    advisoryLock,
    lockExclusion,
    fileFsync,
    directoryFsync,
    ownership,
    reasons,
  };
}

async function probeCompetingFlock(path: string, expectBlocked: boolean): Promise<void> {
  const modulePath = require.resolve("fs-ext");
  const script = [
    `const fs = require("node:fs");`,
    `const fsExt = require(process.argv[1]);`,
    `const fd = fs.openSync(process.argv[2], fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);`,
    `fsExt.flock(fd, "exnb", (error) => {`,
    `const blocked = error && (error.code === "EAGAIN" || error.code === "EWOULDBLOCK");`,
    `const ok = process.argv[3] === "blocked" ? blocked : !error;`,
    `if (!error) fsExt.flock(fd, "un", () => { fs.closeSync(fd); process.exit(ok ? 0 : 2); });`,
    `else { fs.closeSync(fd); process.exit(ok ? 0 : 2); }`,
    `});`,
  ].join("\n");
  const child = spawn(
    process.execPath,
    ["--eval", script, modulePath, path, expectBlocked ? "blocked" : "free"],
    {
      stdio: "ignore",
    }
  );
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("flock exclusion probe timed out"));
    }, 5_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error("flock exclusion probe failed"));
    });
  });
}

function ignoreMissing(error: unknown): void {
  if (!ifMissing(error)) throw error;
}

async function fsyncBaseDirectory(path: string): Promise<void> {
  await assertSafeAncestorChain(path);
  await assertOwnedBaseDirectory(path);
  if (typeof NO_FOLLOW !== "number") throw new Error("O_NOFOLLOW is unavailable");
  const before = identityOf(await lstat(path));
  const handle = await openPromise(
    path,
    constants.O_RDONLY | NO_FOLLOW | (constants.O_DIRECTORY ?? 0)
  );
  try {
    const opened = await handle.stat();
    if (!opened.isDirectory() || !sameIdentity(identityOf(opened), before))
      throw new Error(`Directory identity changed before fsync: ${path}`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function ensureSecureHarnessPaths(
  options: { home?: string } & AtomicWriteOptions = {}
): Promise<HarnessPaths> {
  const suppliedHome = options.home ?? homedir();
  if (!isAbsolute(suppliedHome)) throw new Error("Harness HOME must be absolute");
  const home = resolve(suppliedHome);
  if ((await realpath(home)) !== home) throw new Error("Harness HOME must be canonical");
  await assertSafeAncestorChain(home);
  await assertOwnedBaseDirectory(home);

  const mnemoRoot = join(home, ".mnemo");
  const root = join(mnemoRoot, "harness");
  const pathValues = {
    home,
    mnemoRoot,
    root,
    outbox: join(root, "outbox"),
    state: join(root, "state"),
    capture: join(root, "capture"),
    locks: join(root, "locks"),
    quarantine: join(root, "quarantine"),
    audit: join(root, "audit"),
  };
  for (const path of [
    pathValues.mnemoRoot,
    pathValues.root,
    pathValues.outbox,
    pathValues.state,
    pathValues.capture,
    pathValues.locks,
    pathValues.quarantine,
    pathValues.audit,
  ]) {
    await ensureOwnedDirectory(path);
    const parent = dirname(path);
    if (parent === home) await fsyncBaseDirectory(parent);
    else await fsyncDirectory(parent);
    await options.boundary?.("directory-fsync", parent);
  }
  for (const path of [
    pathValues.outbox,
    pathValues.state,
    pathValues.capture,
    pathValues.locks,
    pathValues.quarantine,
    pathValues.audit,
  ]) {
    await listSecureRegularFiles(path);
  }
  const identities: Record<string, FilesystemIdentity> = {};
  for (const path of new Set([...pathAncestors(home), ...Object.values(pathValues)]))
    identities[path] = identityOf(await lstat(path));
  const paths: HarnessPaths = { ...pathValues, identities };
  return paths;
}

export async function assertHarnessPathsStable(paths: HarnessPaths): Promise<void> {
  await assertSafeAncestorChain(paths.home);
  await assertOwnedBaseDirectory(paths.home);
  for (const [path, expected] of Object.entries(paths.identities)) {
    const info = await lstat(path).catch(() => null);
    if (info === null || !sameIdentity(identityOf(info), expected)) {
      throw new Error(`Managed path identity changed: ${path}`);
    }
  }
  for (const path of [
    paths.mnemoRoot,
    paths.root,
    paths.outbox,
    paths.state,
    paths.locks,
    paths.quarantine,
    paths.audit,
  ])
    await assertOwnedDirectory(path);
}

export async function assertSecureRegularFile(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error(`Unsafe symlink file: ${path}`);
  if (!info.isFile()) throw new Error(`Unsafe non-regular file: ${path}`);
  if (info.uid !== currentUid()) throw new Error(`Unsafe owner for file: ${path}`);
  if (modeOf(info.mode) !== FILE_MODE)
    throw new Error(`Unsafe file mode for ${path}; expected 0600`);
}

export async function secureOpenFile(
  path: string,
  flags: number = constants.O_RDWR | constants.O_CREAT
): Promise<number> {
  if (typeof NO_FOLLOW !== "number") throw new Error("O_NOFOLLOW is unavailable");
  assertSafePathComponent(basename(path));
  await assertOwnedDirectory(dirname(path));
  try {
    await assertSecureRegularFile(path);
  } catch (error) {
    if (!ifMissing(error)) throw error;
  }

  const fd = await openDescriptor(path, flags | NO_FOLLOW, FILE_MODE);
  try {
    const info = await fstatDescriptor(fd);
    if (!info.isFile() || info.uid !== currentUid() || modeOf(info.mode) !== FILE_MODE) {
      throw new Error(`Unsafe opened file: ${path}`);
    }
    return fd;
  } catch (error) {
    await closeDescriptor(fd);
    throw error;
  }
}

export async function withAdvisoryLock<T>(
  paths: HarnessPaths,
  name: string,
  operation: () => Promise<T>
): Promise<T> {
  assertSafePathComponent(name);
  const fsExt = loadFsExt();
  // Every runtime participates in the same portable admission queue, including
  // installations with fs-ext. Otherwise a copied CLI and a workspace runtime
  // could choose different locks for the same state.
  return withExclusiveFileLock(paths, name, async () => {
    if (fsExt === null) {
      const result = await operation();
      await assertHarnessPathsStable(paths);
      return result;
    }
    const lockPath = join(paths.locks, `${name}.lock`);
    const held = heldLocalLocks.getStore();
    if (held?.has(lockPath))
      throw new Error(`Advisory lock is already held by this context: ${name}`);
    await assertHarnessPathsStable(paths);
    const previous = localLockTails.get(lockPath) ?? Promise.resolve();
    let releaseLocal!: () => void;
    const local = new Promise<void>((resolve) => {
      releaseLocal = resolve;
    });
    const tail = previous.then(() => local);
    localLockTails.set(lockPath, tail);
    await previous;
    try {
      await assertHarnessPathsStable(paths);
      const fd = await secureOpenFile(lockPath);
      const flock = promisify(fsExt.flock);
      try {
        await flock(fd, "ex");
        await assertHarnessPathsStable(paths);
        const result = await heldLocalLocks.run(new Set([...(held ?? []), lockPath]), operation);
        await assertHarnessPathsStable(paths);
        return result;
      } finally {
        try {
          await assertHarnessPathsStable(paths);
          await flock(fd, "un");
        } finally {
          await closeDescriptor(fd);
        }
      }
    } finally {
      releaseLocal();
      if (localLockTails.get(lockPath) === tail) localLockTails.delete(lockPath);
    }
  });
}

interface ExclusiveLockOwner {
  pid: number;
  token: string;
  acquiredAt: number;
  ticket?: number;
}

export interface ExclusiveFileLockOptions {
  /** Give up waiting for a live holder after this long. */
  waitMs?: number;
  /** Age threshold for legacy lock files without an admission ticket. */
  staleMs?: number;
}

/**
 * Lamport's bakery admission: each contender publishes a unique choosing file,
 * then a ticket, and waits for earlier tickets and unfinished choices. Unlike a
 * shared recovery mutex, a crashed contender's file can be safely unlinked: its
 * pathname is never reused by a new holder. Live contenders are never evicted
 * by age. Admission covers acquisition, stale recovery AND the operation, so a
 * paused stale observer cannot rename a later holder's lock.
 */
async function enterExclusiveQueue(
  paths: HarnessPaths,
  name: string,
  token: string,
  deadline: number
): Promise<() => Promise<void>> {
  const prefix = `${name}.`;
  const id = `${process.pid}.${token}.ticket`;
  const ownPath = join(paths.locks, prefix + id);
  const owner = { pid: process.pid, token, acquiredAt: Date.now(), ticket: 0 };
  const fd = await secureOpenFile(
    ownPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
  );
  const release = () => unlink(ownPath).catch(ignoreMissing);
  try {
    try {
      await writeDescriptor(fd, JSON.stringify(owner));
      await fsyncDescriptor(fd);
    } finally {
      await closeDescriptor(fd);
    }
    const contenders = async () =>
      (await readdir(paths.locks)).filter(
        (file) =>
          file.startsWith(prefix) && /^\d+\.[0-9a-f-]{36}\.ticket$/.test(file.slice(prefix.length))
      );
    const read = async (file: string) => {
      const path = join(paths.locks, file);
      const pid = Number(file.slice(prefix.length).split(".")[0]);
      if (!processAlive(pid)) {
        await unlink(path).catch(ignoreMissing);
        return undefined;
      }
      const entry = await readLockOwner(path);
      if (entry?.ticket !== undefined && (!Number.isSafeInteger(entry.ticket) || entry.ticket < 0))
        throw new Error(`Invalid exclusive lock ticket: ${file}`);
      return entry;
    };
    let max = 0;
    for (const file of await contenders()) {
      const entry = await read(file);
      max = Math.max(max, entry?.ticket ?? 0);
    }
    owner.ticket = max + 1;
    await atomicWritePrivateFile(ownPath, JSON.stringify(owner));
    for (const file of await contenders()) {
      if (file === prefix + id) continue;
      let delay = 5;
      for (;;) {
        const entry = await read(file);
        if (entry === undefined) break;
        const ticket = entry?.ticket ?? 0;
        if (ticket > owner.ticket || (ticket === owner.ticket && file.slice(prefix.length) > id))
          break;
        if (Date.now() >= deadline)
          throw new Error(`Timed out waiting for exclusive lock: ${name}`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(100, delay * 2);
      }
    }
    return release;
  } catch (error) {
    await release();
    throw error;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readLockOwner(path: string): Promise<ExclusiveLockOwner | null | undefined> {
  try {
    const owner = JSON.parse(await readPrivateFile(path)) as Partial<ExclusiveLockOwner>;
    if (
      typeof owner.pid !== "number" ||
      typeof owner.token !== "string" ||
      typeof owner.acquiredAt !== "number"
    )
      return null;
    return owner as ExclusiveLockOwner;
  } catch (error) {
    if (ifMissing(error)) return undefined;
    // A holder between O_EXCL create and its write leaves an empty file.
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

/**
 * Cross-process mutual exclusion built only on O_CREAT|O_EXCL|O_NOFOLLOW, for
 * writers that ship without the optional native `fs-ext` module (the CLI
 * bundles the harness without its dependencies). A holder whose pid is gone, or
 * that outlived `staleMs` in an older runtime, is recovered only after bakery
 * admission has excluded every other acquirer and stale observer.
 */
export async function withExclusiveFileLock<T>(
  paths: HarnessPaths,
  name: string,
  operation: () => Promise<T>,
  options: ExclusiveFileLockOptions = {}
): Promise<T> {
  assertSafePathComponent(name);
  if (typeof NO_FOLLOW !== "number") throw new Error("O_NOFOLLOW is unavailable");
  const waitMs = options.waitMs ?? 10_000;
  const staleMs = options.staleMs ?? 60_000;
  const lockPath = join(paths.locks, `${name}.excl`);
  const held = heldLocalLocks.getStore();
  if (held?.has(lockPath))
    throw new Error(`Exclusive lock is already held by this context: ${name}`);
  await assertHarnessPathsStable(paths);
  const previous = localLockTails.get(lockPath) ?? Promise.resolve();
  let releaseLocal!: () => void;
  const local = new Promise<void>((resolve) => {
    releaseLocal = resolve;
  });
  const tail = previous.then(() => local);
  localLockTails.set(lockPath, tail);
  await previous;
  let releaseQueue: (() => Promise<void>) | undefined;
  try {
    const token = randomUUID();
    const deadline = Date.now() + waitMs;
    releaseQueue = await enterExclusiveQueue(paths, name, token, deadline);
    let delay = 5;
    for (;;) {
      await assertHarnessPathsStable(paths);
      let fd: number | undefined;
      try {
        fd = await secureOpenFile(
          lockPath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      if (fd !== undefined) {
        try {
          await writeDescriptor(
            fd,
            JSON.stringify({ pid: process.pid, token, acquiredAt: Date.now() })
          );
          await fsyncDescriptor(fd);
        } finally {
          await closeDescriptor(fd);
        }
        break;
      }
      const observed = await lstat(lockPath).catch((error) => {
        if (ifMissing(error)) return undefined;
        throw error;
      });
      if (observed === undefined) continue;
      const owner = await readLockOwner(lockPath);
      if (owner === undefined) continue;
      const stale =
        owner === null
          ? Date.now() - observed.mtimeMs > 5_000
          : !processAlive(owner.pid) || Date.now() - owner.acquiredAt > staleMs;
      if (stale) {
        const tomb = join(paths.locks, `${name}.${randomUUID()}.stale`);
        try {
          await rename(lockPath, tomb);
        } catch (error) {
          if (!ifMissing(error)) throw error;
          continue;
        }
        if (sameIdentity(identityOf(await lstat(tomb)), identityOf(observed))) {
          await unlink(tomb).catch(ignoreMissing);
          continue;
        }
        // A non-cooperating older runtime changed the inode. Preserve evidence
        // and fail closed instead of admitting an operation beside that holder.
        throw new Error(`Exclusive lock identity changed during recovery: ${name}`);
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for exclusive lock: ${name}`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(100, delay * 2);
    }
    try {
      await assertHarnessPathsStable(paths);
      return await heldLocalLocks.run(new Set([...(held ?? []), lockPath]), operation);
    } finally {
      const owner = await readLockOwner(lockPath).catch(() => null);
      if (owner?.token === token) await unlink(lockPath).catch(ignoreMissing);
    }
  } finally {
    try {
      await releaseQueue?.();
    } finally {
      releaseLocal();
      if (localLockTails.get(lockPath) === tail) localLockTails.delete(lockPath);
    }
  }
}

export async function fsyncDirectory(path: string): Promise<void> {
  await assertOwnedDirectory(path);
  if (typeof NO_FOLLOW !== "number") throw new Error("O_NOFOLLOW is unavailable");
  const before = identityOf(await lstat(path));
  const handle = await openPromise(
    path,
    constants.O_RDONLY | NO_FOLLOW | (constants.O_DIRECTORY ?? 0)
  );
  try {
    const opened = await handle.stat();
    if (!opened.isDirectory() || !sameIdentity(identityOf(opened), before)) {
      throw new Error(`Directory identity changed before fsync: ${path}`);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

const ATOMIC_TEMP_PATTERN =
  /^\.(.+)\.[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/i;

export async function recoverAtomicTemporaryFiles(
  directories: readonly string[],
  targetBasenames?: ReadonlySet<string>,
  options: TemporaryRecoveryOptions = {}
): Promise<{ discarded: number }> {
  let discarded = 0;
  for (const directory of directories) {
    await assertOwnedDirectory(directory);
    for (const path of await listSecureRegularFiles(directory)) {
      const match = ATOMIC_TEMP_PATTERN.exec(basename(path));
      if (match === null) continue;
      if (targetBasenames !== undefined && !targetBasenames.has(match[1]!)) continue;
      await options.beforeDiscard?.(path);
      await unlink(path);
      await options.boundary?.("temporary-unlink", path);
      discarded += 1;
      await fsyncDirectory(directory);
      await options.boundary?.("directory-fsync", directory);
    }
  }
  return { discarded };
}

export async function atomicWritePrivateFile(
  target: string,
  bytes: string | Uint8Array,
  options: AtomicWriteOptions = {}
): Promise<void> {
  assertSafePathComponent(basename(target));
  const parent = dirname(target);
  await assertOwnedDirectory(parent);
  try {
    await assertSecureRegularFile(target);
  } catch (error) {
    if (!ifMissing(error)) throw error;
  }

  const temporary = join(parent, `.${basename(target)}.${randomUUID()}.tmp`);
  const fd = await secureOpenFile(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
  );
  let closed = false;
  let renamed = false;
  try {
    await options.boundary?.("temp-open", temporary);
    await writeDescriptor(fd, bytes);
    await options.boundary?.("temp-write", temporary);
    await fsyncDescriptor(fd);
    await options.boundary?.("temp-fsync", temporary);
    await closeDescriptor(fd);
    closed = true;
    await rename(temporary, target);
    renamed = true;
    await options.boundary?.("rename", target);
    await fsyncDirectory(parent);
    await options.boundary?.("directory-fsync", parent);
  } finally {
    if (!closed) await closeDescriptor(fd).catch(() => undefined);
    if (!renamed) await unlink(temporary).catch(() => undefined);
  }
  await assertSecureRegularFile(target);
}

export async function writeFidelityFailureLatch(
  paths: HarnessPaths,
  reason: FidelityFailureReason,
  options: AtomicWriteOptions = {}
): Promise<void> {
  await atomicWritePrivateFile(
    join(paths.state, "full-fidelity.json"),
    canonicalJson({ version: 1, fullFidelity: false, reason }),
    options
  );
}

export async function readPrivateFile(path: string): Promise<string> {
  const fd = await secureOpenFile(path, constants.O_RDONLY);
  try {
    return (await readDescriptor(fd)).toString("utf8");
  } finally {
    await closeDescriptor(fd);
  }
}

export async function listSecureRegularFiles(directory: string): Promise<string[]> {
  await assertOwnedDirectory(directory);
  const names = await readdir(directory);
  const files: string[] = [];
  for (const name of names) {
    assertSafePathComponent(name);
    const path = join(directory, name);
    const info = await lstat(path);
    if (info.isDirectory()) throw new Error(`Unexpected directory in managed storage: ${path}`);
    await assertSecureRegularFile(path);
    files.push(path);
  }
  return files.sort();
}
