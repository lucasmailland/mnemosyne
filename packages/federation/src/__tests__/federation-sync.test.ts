import { describe, it, expect } from "vitest";
import { filterByScope, type SyncRequest, type SyncableRecord } from "../syncProtocol.js";

const recs: SyncableRecord[] = [
  { id: "f1", workspaceId: "ws1", knowledgeType: "facts", updatedAt: "2026-06-01T00:00:00Z" },
  { id: "f2", workspaceId: "ws1", knowledgeType: "entities", updatedAt: "2026-06-05T00:00:00Z" },
  { id: "f3", workspaceId: "ws2", knowledgeType: "facts", updatedAt: "2026-06-05T00:00:00Z" },
];

function req(scope: Partial<SyncRequest["scope"]>): SyncRequest {
  return { fromInstance: "a", toInstance: "b", conflictResolution: "manual",
    scope: { workspaces: ["ws1"], knowledgeTypes: ["facts", "entities"], ...scope } };
}

describe("filterByScope — §20 selective + incremental sync (lines 1568–1577)", () => {
  it("filters by workspace", () => {
    expect(filterByScope(recs, req({})).map((r) => r.id)).toEqual(["f1", "f2"]);
  });
  it("filters by knowledgeType", () => {
    expect(filterByScope(recs, req({ knowledgeTypes: ["facts"] })).map((r) => r.id)).toEqual(["f1"]);
  });
  it("incremental: since drops records updated at or before the cursor", () => {
    const out = filterByScope(recs, req({ since: "2026-06-01T00:00:00Z" }));
    expect(out.map((r) => r.id)).toEqual(["f2"]);
  });
  it("combines workspace + type + since", () => {
    const out = filterByScope(recs, req({ knowledgeTypes: ["facts"], since: "2026-05-01T00:00:00Z" }));
    expect(out.map((r) => r.id)).toEqual(["f1"]);
  });
});
