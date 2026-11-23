/**
 * APP-015: the recall route must not add invented "tokens saved" figures.
 * It used to add a flat 200 per composition inference and 350 per hot-tier
 * hit. Measured served context is GET /admin/stats → context.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = readFileSync(fileURLToPath(new URL("../../routes/recall.ts", import.meta.url)), "utf8");

describe("recall route — no flat token-saving estimates (APP-015)", () => {
  it("never increments tokensSavedTotal", () => {
    expect(src).not.toMatch(/tokensSavedTotal\s*\.inc\(/);
  });
});
