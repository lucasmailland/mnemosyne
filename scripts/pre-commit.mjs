#!/usr/bin/env node
// Pre-commit: run prettier on the staged files (what lint-staged used to do,
// without its dependency tree). Same file set as before: ts/tsx/js/jsx/mjs/cjs
// and json/md/yml/yaml, never pnpm-lock.yaml; .prettierignore still applies.
//
// Fully staged files are formatted in place and re-added. A file with unstaged
// changes too only gets its staged content formatted (straight into the index),
// so `git add -p` work is never swept into the commit.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|yml|yaml)$/;

const git = (args, input) =>
  execFileSync("git", args, { encoding: "utf8", input, maxBuffer: 64 << 20 });
const list = (args) =>
  git([...args, "-z"])
    .split("\0")
    .filter(Boolean);

const root = git(["rev-parse", "--show-toplevel"]).trim();
const bin = join(
  root,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "prettier.cmd" : "prettier"
);
const prettier = existsSync(bin) ? bin : "prettier";

const staged = list(["diff", "--cached", "--name-only", "--diff-filter=ACMR"]).filter(
  (f) => EXT.test(f) && !/(^|\/)pnpm-lock\.yaml$/.test(f)
);
if (staged.length === 0) process.exit(0);

const unstaged = new Set(list(["diff", "--name-only"]));
const whole = staged.filter((f) => !unstaged.has(f));
const partial = staged.filter((f) => unstaged.has(f));

const opts = { cwd: root, stdio: ["pipe", "pipe", "inherit"], maxBuffer: 64 << 20 };

if (whole.length > 0) {
  execFileSync(prettier, ["--write", "--log-level", "warn", "--", ...whole], opts);
  git(["add", "--", ...whole]);
}

for (const file of partial) {
  const [mode] = git(["ls-files", "-s", "--", file]).split(" ");
  const formatted = execFileSync(prettier, ["--stdin-filepath", file], {
    ...opts,
    input: git(["show", `:${file}`]),
    encoding: "utf8",
  });
  const blob = git(["hash-object", "-w", "--stdin", "--path", file], formatted).trim();
  git(["update-index", "--cacheinfo", `${mode},${blob},${file}`]);
  console.log(`pre-commit: formatted the staged part of ${file} (it has unstaged changes)`);
}
