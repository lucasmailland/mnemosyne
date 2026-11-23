import { describe, it, expect } from "vitest";
import { exportVault } from "../obsidian-export.js";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginContext } from "../../index.js";

describe("obsidian-export exportVault", () => {
  it("writes one .md file per recall hit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "obsidian-test-"));
    const ctx = {
      workspaceId: "ws",
      config: {},
      recall: async () => [
        { id: "f-1", content: "Fact one", score: 0.9 },
        { id: "f-2", content: "Fact two", score: 0.8 },
      ],
      log: { info: () => {} },
    } as unknown as PluginContext;

    await exportVault(ctx, dir);
    const files = await readdir(dir);
    expect(files).toHaveLength(2);
    expect(files).toContain("f-1.md");
    expect(files).toContain("f-2.md");
  });

  it("throws when no dir provided", async () => {
    const ctx = { workspaceId: "ws", config: {}, recall: async () => [] } as unknown as PluginContext;
    await expect(exportVault(ctx, "")).rejects.toThrow("dir required");
  });
});
