import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { MCP_VERSION } from "../version.js";

it("uses the package version for the MCP handshake", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8")
  ) as { version: string };
  expect(MCP_VERSION).toBe(manifest.version);
});
