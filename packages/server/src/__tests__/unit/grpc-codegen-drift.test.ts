import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { format, resolveConfig } from "prettier";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const committed = join(pkgRoot, "src/gen/mnemosyne_pb.ts");

const hasBuf = (() => {
  try {
    execFileSync("pnpm", ["exec", "buf", "--version"], { cwd: pkgRoot, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
})();

describe("gRPC codegen is in sync with the proto", () => {
  it.skipIf(!hasBuf)(
    "buf generate output matches the committed src/gen file",
    async () => {
      // Generate into a temp dir so the run never touches the tracked file.
      const out = mkdtempSync(join(tmpdir(), "mnemo-buf-"));
      try {
        execFileSync("pnpm", ["exec", "buf", "generate", "-o", out], {
          cwd: pkgRoot,
          stdio: "pipe",
        });
        // The committed file went through the pre-commit prettier; buf's raw
        // output differs only in formatting, so compare after the same pass.
        const generated = readFileSync(join(out, "src/gen/mnemosyne_pb.ts"), "utf8");
        const options = (await resolveConfig(committed)) ?? {};
        const formatted = await format(generated, { ...options, filepath: committed });
        expect(formatted).toBe(readFileSync(committed, "utf8"));
      } finally {
        rmSync(out, { recursive: true, force: true });
      }
    },
    30_000
  );
});
