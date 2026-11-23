import { describe, it, expect } from "vitest";
import { normalizeImport, type ImportVendor } from "../../routes/importNormalizers.js";

describe("normalizeImport", () => {
  it("converts mem0 export records into mnemo fact lines", () => {
    const mem0 = [
      { id: "m1", memory: "User prefers dark mode", user_id: "u-7", metadata: { source: "chat" } },
    ];
    const out = normalizeImport("mem0" as ImportVendor, mem0, "ws-1");
    expect(out[0]).toMatchObject({ _type: "header", version: "mnemo-export-v1", workspaceId: "ws-1" });
    expect(out[1]).toMatchObject({ _type: "fact", statement: "User prefers dark mode", subject: "u-7" });
    expect((out[1] as Record<string, unknown>)["metadata"]).toMatchObject({ source: "chat", importedFrom: "mem0" });
  });

  it("converts zep memory messages into mnemo episode lines", () => {
    const zep = [{ uuid: "z1", content: "Discussed Q3 roadmap", role: "assistant", created_at: "2026-01-02T00:00:00Z" }];
    const out = normalizeImport("zep" as ImportVendor, zep, "ws-1");
    expect(out[1]).toMatchObject({ _type: "episode", narrative: "Discussed Q3 roadmap" });
  });

  it("converts claude memory entries into mnemo fact lines", () => {
    const claude = [{ text: "Project ships on Friday", created_at: "2026-01-03T00:00:00Z" }];
    const out = normalizeImport("claude" as ImportVendor, claude, "ws-1");
    expect(out[1]).toMatchObject({ _type: "fact", statement: "Project ships on Friday" });
  });

  it("rejects an unknown vendor", () => {
    expect(() => normalizeImport("notavendor" as ImportVendor, [], "ws-1")).toThrow(/unknown import vendor/i);
  });
});
