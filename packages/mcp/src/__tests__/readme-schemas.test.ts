import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { READMES, renderReadme } from "../../scripts/readme-schemas.js";

// The README input schemas are generated from what the server serves
// (contracts/*.json and the MCP dictionaries). Fix a failure with
// `pnpm --filter @mnemo-ai/mcp readme:schemas`.
describe("README input schemas match the served tools", () => {
  it.each(Object.keys(READMES) as Array<keyof typeof READMES>)(
    "%s",
    async (locale) => {
      const readme = readFileSync(READMES[locale], "utf8");
      expect(readme.match(/<!-- input-schema:memory_/g)?.length).toBe(20);
      expect(readme).toBe(await renderReadme(locale));
    },
    30_000
  );
});
