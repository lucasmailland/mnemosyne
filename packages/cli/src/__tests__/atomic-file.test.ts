/**
 * These properties are about a file the USER owns. Getting them wrong does not
 * fail loudly — it silently narrows a config's permissions, or writes through a
 * symlink to somewhere the operator never named.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AtomicReplaceError, atomicReplace, identifyFile } from "../atomic-file.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "mnemo-atomic-"));
  dirs.push(dir);
  return dir;
}

describe("replacing a file preserves what the user chose", () => {
  it("keeps an existing file's mode instead of narrowing it to 0600", () => {
    const dir = scratch();
    const target = join(dir, "config.json");
    writeFileSync(target, "old");
    chmodSync(target, 0o644);

    atomicReplace(target, "new", { expect: identifyFile(target) });

    expect(readFileSync(target, "utf8")).toBe("new");
    // The original wrote every temp file 0o600, so a config the user had
    // deliberately made group-readable came back private after an install.
    expect(statSync(target).mode & 0o777).toBe(0o644);
  });

  it("uses 0600 only when creating a file that did not exist", () => {
    const dir = scratch();
    const target = join(dir, "created.json");

    atomicReplace(target, "fresh");

    expect(readFileSync(target, "utf8")).toBe("fresh");
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  it("leaves no temporary file behind on success", () => {
    const dir = scratch();
    const target = join(dir, "config.json");
    writeFileSync(target, "old");
    atomicReplace(target, "new", { expect: identifyFile(target) });
    expect(readFileSync(target, "utf8")).toBe("new");
  });
});

describe("refusing to write somewhere other than what was resolved", () => {
  it("refuses to follow a symlink rather than writing through it", () => {
    const dir = scratch();
    const real = join(dir, "elsewhere.json");
    const link = join(dir, "config.json");
    writeFileSync(real, "victim");
    symlinkSync(real, link);

    expect(() => atomicReplace(link, "attacker")).toThrow(AtomicReplaceError);
    // The critical assertion: the link's TARGET is untouched.
    expect(readFileSync(real, "utf8")).toBe("victim");
  });

  it("refuses when the path became a different file after it was resolved", () => {
    const dir = scratch();
    const target = join(dir, "config.json");
    writeFileSync(target, "resolved");
    const identity = identifyFile(target);

    // The window this closes: resolution, then parsing and validation, then the
    // write — and in between, the path comes to name a different inode.
    const impostor = join(dir, "impostor.json");
    writeFileSync(impostor, "swapped");
    renameSync(impostor, target);

    expect(() => atomicReplace(target, "new", { expect: identity })).toThrow(
      /no longer the file that was resolved/
    );
    expect(readFileSync(target, "utf8")).toBe("swapped");
  });

  it("refuses when a resolved file has since vanished", () => {
    const dir = scratch();
    const target = join(dir, "config.json");
    writeFileSync(target, "resolved");
    const identity = identifyFile(target);
    rmSync(target);

    expect(() => atomicReplace(target, "new", { expect: identity })).toThrow(
      /disappeared after it was resolved/
    );
  });

  it("still creates a file when the caller resolved nothing", () => {
    const dir = scratch();
    const target = join(dir, "config.json");
    expect(identifyFile(target)).toBeNull();
    atomicReplace(target, "new", { expect: null });
    expect(readFileSync(target, "utf8")).toBe("new");
  });
});
