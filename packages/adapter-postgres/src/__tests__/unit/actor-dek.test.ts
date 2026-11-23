import { describe, it, expect } from "vitest";
import { actorDekTable } from "../../schema/infrastructure.js";

describe("actorDekTable schema", () => {
  it("exports the table", () => {
    expect(actorDekTable).toBeDefined();
  });

  it("has workspaceId and actorId columns", () => {
    const cols = actorDekTable;
    expect(cols.workspaceId).toBeDefined();
    expect(cols.actorId).toBeDefined();
    expect(cols.status).toBeDefined();
    expect(cols.destroyedAt).toBeDefined();
  });
});
