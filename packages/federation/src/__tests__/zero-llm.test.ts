import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

const RESOLVER_FILES = ["resolveConflict.ts", "federatedConsensus.ts", "consensus.ts", "trust.ts"];
const FORBIDDEN = ["@mnemo-ai/adapter-llm", "anthropic", "openai", "drizzle-orm", '"pg"', "ioredis", "node:http", "fetch("];

describe("§33 resolvers are zero-LLM, pure deterministic", () => {
  for (const f of RESOLVER_FILES) {
    it(`${f} imports no LLM/adapter/IO`, () => {
      const content = readFileSync(join(SRC, f), "utf8");
      for (const bad of FORBIDDEN) {
        expect(content.includes(bad), `${f} must not reference ${bad}`).toBe(false);
      }
    });
  }
});
