// B6.35 Task 4 — the CUP v2→v3 mapper must never carry the reserved
// pending-consolidation marker from a v2 record into a migrated v3 fact.
// Every v2 memory_type that maps to a fact strips the key while preserving
// sibling metadata and all CUP provenance fields. Episode/skill mappings are
// unchanged because they do not insert mnemo_fact.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { mapV2Memory, type V2Memory, type MappedFact } from "../TypeMapper.js";

const FACT_TYPES = ["semantic", "working", "factual", "relational", "preference"] as const;

function makeV2(memory_type: string, extra: Partial<V2Memory> = {}): V2Memory {
  return {
    id: "mem-1",
    workspace_id: "ws-1",
    agent_id: "agent-1",
    memory_type,
    content: "some content",
    subject: "subj",
    created_at: "2024-01-01T00:00:00.000Z",
    updated_at: "2024-01-01T00:00:00.000Z",
    metadata: {
      sibling: "kept",
      __mnemoConsolidationPending: { operationId: "spoofed" },
    },
    ...extra,
  };
}

describe("TypeMapper strips the reserved pending marker for every fact type", () => {
  it.each(FACT_TYPES)("maps %s → fact without the reserved key", (type) => {
    const mapped = mapV2Memory(makeV2(type, type === "relational" ? { entity_id: "ent-1" } : {}));
    expect(mapped.type).toBe("fact");
    const meta = (mapped as MappedFact).input.metadata!;
    // Sibling + CUP provenance preserved.
    expect(meta).toMatchObject({
      sibling: "kept",
      v2Id: "mem-1",
      v2MemoryType: type,
      worthAlpha: 1.0,
      worthBeta: 2.0,
    });
    // Reserved key stripped.
    expect(meta).not.toHaveProperty("__mnemoConsolidationPending");
  });

  it("preserves a clean fact's metadata untouched (no marker present)", () => {
    const v2 = makeV2("factual", { metadata: { sibling: "kept" } });
    const mapped = mapV2Memory(v2) as MappedFact;
    expect(mapped.input.metadata).toMatchObject({ sibling: "kept", v2Id: "mem-1" });
    expect(mapped.input.metadata).not.toHaveProperty("__mnemoConsolidationPending");
  });
});

describe("TypeMapper.ts source guard", () => {
  it("mapToFact never assigns raw v2 metadata without the sanitizer", () => {
    const HERE = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(resolve(HERE, "../TypeMapper.ts"), "utf8");
    const mapToFact = source.slice(source.indexOf("function mapToFact"), source.indexOf("function mapToEpisode"));
    // The fact builder must spread the sanitized object, never `...v2.metadata`.
    expect(mapToFact).toMatch(/\.\.\.safeV2Metadata/);
    expect(mapToFact).not.toMatch(/\.\.\.v2\.metadata/);
    expect(mapToFact).toMatch(/__mnemoConsolidationPending: _pending/);
  });
});
