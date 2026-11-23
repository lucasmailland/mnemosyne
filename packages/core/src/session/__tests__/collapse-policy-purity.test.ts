import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("hexagonal purity: collapse-policy.ts", () => {
  it("imports nothing from drizzle-orm / pg / redis / adapter packages", () => {
    const path = fileURLToPath(new URL("../collapse-policy.ts", import.meta.url));
    const src = readFileSync(path, "utf8");
    // Inspect only the import statements — comments may legitimately mention
    // "redis" / "pg" / "drizzle-orm" when documenting the purity rule itself.
    const importLines = src
      .split(/\r?\n/)
      .filter((l) => /^\s*import\b/.test(l) || /\bfrom\s+["']/.test(l));
    const joined = importLines.join("\n");
    const forbidden = [
      "drizzle-orm",
      "from \"pg\"",
      "from 'pg'",
      "ioredis",
      "from \"redis\"",
      "from 'redis'",
      "@mnemo-ai/adapter-",
    ];
    for (const needle of forbidden) {
      expect(joined.includes(needle), `collapse-policy.ts must not import ${needle}`).toBe(false);
    }
    // Positive: it may import from @mnemo-ai/types and the local collapse.js only.
    expect(joined.includes("@mnemo-ai/types")).toBe(true);
  });
});
