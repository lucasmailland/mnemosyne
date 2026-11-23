/// <reference types="node" />
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Hexagonal-purity guard (cardinal rule):
 * @mnemo-ai/types is the domain layer — it must never import
 * infrastructure packages. A violation here poisons every consumer.
 */

const FORBIDDEN = [
  "drizzle-orm",
  '"postgres"',
  "'postgres'",
  '"pg"',
  "'pg'",
  "ioredis",
  '"redis"',
  "'redis'",
  "@neondatabase",
];

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "__tests__") continue;
      out.push(...collectTsFiles(full));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("hexagonal purity: @mnemo-ai/types", () => {
  it("has zero infrastructure imports in src/", () => {
    const violations: string[] = [];
    for (const file of collectTsFiles(SRC_DIR)) {
      const content = readFileSync(file, "utf8");
      for (const specifier of FORBIDDEN) {
        // Only flag actual import/require lines, not comments mentioning the name.
        const importLine = new RegExp(
          `(import|require)[^\\n]*${specifier.replace(/["']/g, "[\"']")}`,
        );
        if (importLine.test(content)) {
          violations.push(`${file} imports ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
