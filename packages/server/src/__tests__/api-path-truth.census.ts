/**
 * Pure scanning logic for the api-path-truth guard (A5, Req 11).
 *
 * Split from api-path-truth.test.ts so the core algorithm is unit-testable
 * against in-memory fixtures without touching the real filesystem — the
 * guard's own success criterion ("fails on a newly introduced /v1/") is
 * asserted this way, not by mutating a real file (design.md, A1 "Guard
 * design", "Self-test without polluting the repo").
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Allowance } from "./api-path-truth.allowlist.js";

const execFileAsync = promisify(execFile);

/** The literal pattern the guard enforces — trailing slash included (design.md, "Match pattern"). */
const V1_PATTERN = "/v1/";

export interface Violation {
  /** `file:line` for a single ungoverned occurrence, or the allowance's own path for a count mismatch. */
  location: string;
  message: string;
}

function matchesPath(filePath: string, allowancePath: string): boolean {
  if (allowancePath.endsWith("/")) return filePath.startsWith(allowancePath);
  return filePath === allowancePath;
}

/** Counts non-overlapping occurrences of a literal substring in a line (matches ripgrep's `-o` semantics). */
function countOccurrences(line: string, needle: string): number {
  let count = 0;
  let idx = line.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = line.indexOf(needle, idx + needle.length);
  }
  return count;
}

/**
 * Pure census function: scans `files` for the literal `/v1/` and reports
 * every occurrence not covered by `allowlist`.
 *
 * @param files repo-relative path -> file contents
 * @param allowlist the reviewed Allowance list (frozen / foreign / unswept)
 */
export function census(
  files: ReadonlyMap<string, string>,
  allowlist: readonly Allowance[]
): Violation[] {
  const violations: Violation[] = [];
  const countingAllowances = allowlist.filter((a) => a.kind === "frozen" || a.kind === "unswept");
  const actualCounts = new Map<Allowance, number>(countingAllowances.map((a) => [a, 0]));

  for (const [filePath, content] of files) {
    const lines = content.split("\n");
    const applicableCounting = countingAllowances.filter((a) => matchesPath(filePath, a.path));
    const applicableForeign = allowlist.filter(
      (a): a is Extract<Allowance, { kind: "foreign" }> =>
        a.kind === "foreign" && matchesPath(filePath, a.path)
    );

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const occurrences = countOccurrences(line, V1_PATTERN);
      if (occurrences === 0) continue;

      if (applicableForeign.some((a) => a.pattern.test(line))) continue;

      if (applicableCounting.length > 0) {
        for (const a of applicableCounting) {
          actualCounts.set(a, (actualCounts.get(a) ?? 0) + occurrences);
        }
        continue;
      }

      violations.push({
        location: `${filePath}:${i + 1}`,
        message: `Unallowlisted /v1/ in ${filePath}:${i + 1}: ${line.trim()}`,
      });
    }
  }

  for (const a of countingAllowances) {
    const actual = actualCounts.get(a) ?? 0;
    if (actual !== a.expected) {
      violations.push({
        location: a.path,
        message: `${a.kind} allowance "${a.path}" expected exactly ${a.expected} occurrence(s) of /v1/, found ${actual}`,
      });
    }
  }

  return violations;
}

/**
 * Enumerates every tracked or unignored untracked file in the repository via
 * `git ls-files --cached --others --exclude-standard -z` and returns
 * repo-relative path -> file contents for every text file. Binary
 * files (containing a NUL byte, e.g. tracked __pycache__ artifacts) are
 * skipped — they cannot contain a meaningful documentary or code claim, only
 * incidental byte matches.
 *
 * Throws loudly outside a git checkout (CONTRIBUTING.md: "No silent
 * failures" — design.md, A1 "Guard design").
 */
export async function listRepoFiles(cwd: string): Promise<Map<string, string>> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      {
        cwd,
        maxBuffer: 1024 * 1024 * 64,
      }
    ));
  } catch (err) {
    throw new Error(
      `api-path-truth guard: not a git checkout (or "git ls-files" failed) at ${cwd}. ` +
        `This guard requires a git checkout to enumerate files. Original error: ${
          err instanceof Error ? err.message : String(err)
        }`
    );
  }

  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const paths = stdout.split("\0").filter(Boolean);
  const files = new Map<string, string>();

  for (const relPath of paths) {
    const buf = await readFile(join(cwd, relPath));
    if (buf.includes(0)) continue; // binary — skip
    files.set(relPath, buf.toString("utf8"));
  }

  return files;
}
