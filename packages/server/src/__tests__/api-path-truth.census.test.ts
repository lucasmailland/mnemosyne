import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, it, expect } from "vitest";
import { census } from "./api-path-truth.census.js";
import type { Allowance } from "./api-path-truth.allowlist.js";

const execFileAsync = promisify(execFile);

describe("census() — pure /v1/ scanner (A5, Req 11)", () => {
  it("flags a new /v1/ occurrence with no allowlist entry", () => {
    const files = new Map([["packages/server/src/routes/facts.ts", "// calls POST /v1/facts"]]);
    const violations = census(files, []);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.message).toContain("packages/server/src/routes/facts.ts:1");
  });

  it("passes when allowlisted content matches its frozen entry exactly (Scenario: allowlisted content passes)", () => {
    const files = new Map([["docs/AUDIT_REPORT.md", "old note: POST /v1/facts was the path"]]);
    const allowlist: Allowance[] = [
      { kind: "frozen", path: "docs/AUDIT_REPORT.md", expected: 1, reason: "historical" },
    ];
    expect(census(files, allowlist)).toEqual([]);
  });

  it("fails a frozen allowance on UNDER-count (someone 'cleaned' history)", () => {
    // Allowlist pins 2 occurrences, but the file now has only 1 — history was edited.
    const files = new Map([["docs/AUDIT_REPORT.md", "POST /v1/facts"]]);
    const allowlist: Allowance[] = [
      { kind: "frozen", path: "docs/AUDIT_REPORT.md", expected: 2, reason: "historical" },
    ];
    const violations = census(files, allowlist);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.message).toContain("expected exactly 2");
    expect(violations[0]!.message).toContain("found 1");
  });

  it("fails a frozen allowance on OVER-count (a new /v1/ slipped into frozen content)", () => {
    const files = new Map([["docs/AUDIT_REPORT.md", "POST /v1/facts\nPOST /v1/recall"]]);
    const allowlist: Allowance[] = [
      { kind: "frozen", path: "docs/AUDIT_REPORT.md", expected: 1, reason: "historical" },
    ];
    const violations = census(files, allowlist);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.message).toContain("expected exactly 1");
    expect(violations[0]!.message).toContain("found 2");
  });

  it("scopes a foreign allowance narrowly — only the matching pattern is exempt", () => {
    const files = new Map([
      [
        "scripts/collect-soc2-evidence.sh",
        'curl "${PROMETHEUS_URL}/api/v1/query"\ncurl "${MNEMO_URL}/v1/recall"',
      ],
    ]);
    const allowlist: Allowance[] = [
      {
        kind: "foreign",
        path: "scripts/collect-soc2-evidence.sh",
        pattern: /\$\{PROMETHEUS_URL\}\/api\/v1\/query/,
        reason: "real Prometheus path",
      },
    ];
    const violations = census(files, allowlist);
    // Line 1 (Prometheus) is exempt; line 2 (our own /v1/recall) is NOT — it is
    // not allowed to hide behind the same file's foreign allowance.
    expect(violations).toHaveLength(1);
    expect(violations[0]!.message).toContain("scripts/collect-soc2-evidence.sh:2");
  });

  it("a directory-prefix unswept allowance covers every file beneath it", () => {
    const files = new Map([
      ["packages/server/src/routes/facts.ts", "// POST /v1/facts"],
      ["packages/server/src/routes/recall.ts", "// POST /v1/recall"],
    ]);
    const allowlist: Allowance[] = [
      { kind: "unswept", path: "packages/server/src/routes/", expected: 2, sweptBy: "A6" },
    ];
    expect(census(files, allowlist)).toEqual([]);
  });

  it("a partial sweep that deletes the unswept entry surfaces the remaining occurrences", () => {
    // Simulates: sweeper fixed 1 of 2 occurrences and (incorrectly) removed the
    // allowlist entry believing the sweep was complete.
    const files = new Map([["packages/server/src/routes/facts.ts", "// POST /v1/facts"]]);
    const violations = census(files, []);
    expect(violations).toHaveLength(1);
  });

  it("counts every occurrence on a line with multiple /v1/ matches, not just the line", () => {
    // A single line mentioning /v1/ twice must count as 2 occurrences against
    // a frozen allowance's exact pin — matching ripgrep's -o (occurrence, not
    // line) semantics, which is how the allowlist's `expected` counts were
    // derived.
    const files = new Map([
      ["docs/AUDIT_REPORT.md", "compare POST /v1/facts with GET /v1/facts/:id"],
    ]);
    const allowlist: Allowance[] = [
      { kind: "frozen", path: "docs/AUDIT_REPORT.md", expected: 2, reason: "historical" },
    ];
    expect(census(files, allowlist)).toEqual([]);
  });

  it("throws loudly when asked to enumerate outside a git checkout", async () => {
    const { listRepoFiles } = await import("./api-path-truth.census.js");
    await expect(listRepoFiles("/tmp")).rejects.toThrow(/git checkout/i);
  });

  it("enumerates tracked and intended untracked files while excluding ignored files", async () => {
    const { listRepoFiles } = await import("./api-path-truth.census.js");
    const cwd = await mkdtemp(join(tmpdir(), "api-path-truth-"));
    try {
      await execFileAsync("git", ["init", "-q"], { cwd });
      await writeFile(join(cwd, "tracked.ts"), "tracked");
      await writeFile(join(cwd, "untracked.ts"), "untracked");
      await writeFile(join(cwd, "ignored.ts"), "ignored");
      await writeFile(join(cwd, ".gitignore"), "ignored.ts\n");
      await execFileAsync("git", ["add", "tracked.ts"], { cwd });

      const files = await listRepoFiles(cwd);

      expect(files.get("tracked.ts")).toBe("tracked");
      expect(files.get("untracked.ts")).toBe("untracked");
      expect(files.has("ignored.ts")).toBe(false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
