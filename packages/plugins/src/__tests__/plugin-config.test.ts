import { describe, it, expect } from "vitest";
import { parsePluginConfig } from "../config.js";

describe("parsePluginConfig (mnemo.config.yaml)", () => {
  it("parses load list when allowUnsandboxedPlugins is true", () => {
    const yaml = `
plugins:
  allowUnsandboxedPlugins: true
  load:
    - package: "@org/p-a"
    - package: "@org/p-b"
      config:
        token: "abc"
`;
    const cfg = parsePluginConfig(yaml);
    expect(cfg.registrations).toEqual([
      { type: "package", packageName: "@org/p-a", config: {} },
      { type: "package", packageName: "@org/p-b", config: { token: "abc" } },
    ]);
  });

  it("returns NO registrations when allowUnsandboxedPlugins is missing/false", () => {
    const cfg = parsePluginConfig(`plugins:\n  load:\n    - package: "@org/p-a"\n`);
    expect(cfg.registrations).toEqual([]);
    expect(cfg.blockedReason).toBe("allowUnsandboxedPlugins not set");
  });

  it("tolerates empty/absent plugins block", () => {
    expect(parsePluginConfig("").registrations).toEqual([]);
  });
});
