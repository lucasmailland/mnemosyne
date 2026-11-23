import { describe, it, expect } from "vitest";
import { buildExportHeader } from "../../routes/export.js";

describe("buildExportHeader", () => {
  it("includes schemaVersion, region, and computed counts", () => {
    const h = buildExportHeader({
      workspaceId: "ws-1",
      exportedAt: "2026-06-20T00:00:00Z",
      region: "us-east-1",
      factCount: 12,
      entityCount: 40,
      totalLines: 41,
    });
    expect(h).toMatchObject({
      _type: "header",
      version: "mnemo-export-v1",
      schemaVersion: "mnemo-export-v1",
      workspaceId: "ws-1",
      region: "us-east-1",
      factCount: 12,
      entityCount: 40,
      totalLines: 41,
      embeddingsExcluded: true,
    });
  });
});
