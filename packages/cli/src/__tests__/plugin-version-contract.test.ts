import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const readJson = (path: string) => JSON.parse(readFileSync(join(root, path), "utf8"));

describe("plugin version contract", () => {
  it("agrees across host manifests and the Claude marketplace", () => {
    const version = readJson("packages/plugin/.claude-plugin/plugin.json").version;
    const manifests = [
      ".claude-plugin/plugin.json",
      ".codex-plugin/plugin.json",
      ".cursor-plugin/plugin.json",
      "gemini-extension.json",
    ];
    for (const path of manifests) {
      expect(readJson(`packages/plugin/${path}`).version, path).toBe(version);
    }
    expect(readJson(".claude-plugin/marketplace.json").plugins[0].version).toBe(version);
    const registry = readJson("marketplace/registry.json").plugins.mnemosyne;
    expect(registry.latest).toBe(version);
    expect(registry.versions[version]).toBeDefined();
  });
});
