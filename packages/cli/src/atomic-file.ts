/**
 * Replace a file's contents without ever leaving a half-written config behind.
 *
 * Write to a sibling temp file, fsync it, rename over the target: the rename is
 * atomic within a directory, so a reader sees either the old file or the new one
 * and never a truncated one. This matters more than usual here — the files being
 * replaced are the host's own config, and a corrupted `opencode.json` or
 * `config.toml` breaks the tool the user was in the middle of using.
 *
 * Two properties beyond the original private copy this was lifted from:
 *
 *   - The target is re-identified immediately before the rename and compared to
 *     the identity observed at resolution time. Config resolution and writing are
 *     separated by parsing and validation, and in that window the path can become
 *     a different file — or a symlink pointing somewhere else entirely.
 *   - An existing file keeps its mode. The original created every temp file
 *     `0o600` unconditionally, so replacing a deliberately group-readable config
 *     silently narrowed it, which reads as a permissions bug in the host and not
 *     as something an installer did.
 */

import { t } from "./i18n/index.js";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

/** A file's identity, as observed when its path was resolved. */
export interface FileIdentity {
  dev: number;
  ino: number;
}

/** Identify the file at `path`, or null when nothing is there yet. */
export function identifyFile(path: string): FileIdentity | null {
  try {
    const stats = statSync(path);
    return { dev: stats.dev, ino: stats.ino };
  } catch {
    return null;
  }
}

export class AtomicReplaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AtomicReplaceError";
  }
}

export interface AtomicReplaceOptions {
  /**
   * The identity the target had when its path was resolved, if it existed.
   *
   * Supplying it closes the window between "we decided this file is the one to
   * edit" and "we replace it": if the path now names a different inode, the file
   * we validated is not the file we would overwrite, so nothing is written.
   */
  expect?: FileIdentity | null;
  /**
   * Force this mode instead of keeping the existing file's. For a file that is
   * about to hold a credential: keeping a world-readable mode there is the bug.
   */
  mode?: number;
}

/**
 * Write `contents` over `target` atomically.
 *
 * Throws `AtomicReplaceError` rather than replacing when the target has become a
 * symlink or a different file since it was resolved. Refusing is the only safe
 * answer: the alternative is following a link an attacker (or a stale editor)
 * placed there and writing the operator's config somewhere else.
 */
export function atomicReplace(
  target: string,
  contents: string,
  options: AtomicReplaceOptions = {}
): void {
  const existing = verifyTargetIdentity(target, options.expect);

  const temporary = join(dirname(target), `.${basename(target)}.mnemo-${process.pid}.tmp`);
  try {
    // An existing file keeps the mode it had; only a file we are CREATING gets
    // the restrictive default, since there is no prior intent to preserve.
    writeFileSync(temporary, contents, { mode: options.mode ?? existing?.mode ?? 0o600 });
    const fd = openSync(temporary, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, target);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      /* the temporary may never have been created */
    }
    throw error;
  }
}

/**
 * Open the target without following symlinks and confirm it is still the file we
 * resolved. Returns its mode when it exists, null when it does not.
 */
function verifyTargetIdentity(
  target: string,
  expected: FileIdentity | null | undefined
): { mode: number } | null {
  let fd: number;
  try {
    // O_NOFOLLOW makes a symlink an error (ELOOP) rather than a redirect.
    fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP") {
      throw new AtomicReplaceError(t("atomic.symlink", { target }));
    }
    if (code === "ENOENT") {
      // Creating a file that does not exist is fine — but not if the caller
      // resolved one that did, because then it vanished under us.
      if (expected) {
        throw new AtomicReplaceError(t("atomic.disappeared", { target }));
      }
      return null;
    }
    throw error;
  }

  try {
    const stats = fstatSync(fd);
    if (expected && (stats.dev !== expected.dev || stats.ino !== expected.ino)) {
      throw new AtomicReplaceError(t("atomic.changed", { target }));
    }
    return { mode: stats.mode & 0o777 };
  } finally {
    closeSync(fd);
  }
}

/**
 * The file a config path really names. A config kept in a dotfiles repo behind a
 * symlink is the user's deliberate setup: resolving it HERE, when the path is
 * identified, lets the target be replaced atomically while the link stays put.
 * A link that appears AFTER this point is still refused by `atomicReplace`. A
 * dangling link resolves to itself, and `atomicReplace` refuses it.
 */
export function resolveWriteTarget(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** A config that exists but does not parse: rewriting it would destroy whatever it held. */
export class ConfigNotJsonError extends AtomicReplaceError {
  constructor(target: string) {
    super(t("atomic.notJson", { target }));
    this.name = "ConfigNotJsonError";
  }
}

/**
 * Rewrite the JSON config at `path` through `mutate`, keeping every key `mutate`
 * leaves alone. For host configs about to hold an API key: the write is atomic,
 * the mode is forced to 0600, and a symlinked config is written at its target.
 * Throws `ConfigNotJsonError` — writing nothing — when the file is not a JSON object.
 */
export function writeSecretJsonConfig(
  path: string,
  mutate: (config: Record<string, unknown>) => void
): void {
  const target = resolveWriteTarget(path);
  const identity = identifyFile(target);
  let config: Record<string, unknown> = {};
  if (identity) {
    const text = readFileSync(target, "utf8");
    if (text.trim()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new ConfigNotJsonError(path);
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new ConfigNotJsonError(path);
      }
      config = parsed as Record<string, unknown>;
    }
  }
  mutate(config);
  mkdirSync(dirname(target), { recursive: true });
  atomicReplace(target, JSON.stringify(config, null, 2) + "\n", { expect: identity, mode: 0o600 });
}
