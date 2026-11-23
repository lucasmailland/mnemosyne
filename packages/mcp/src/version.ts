import { readFileSync } from "node:fs";

// src/ in tests and dist/ in the published binary are both one level below package.json.
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};
export const MCP_VERSION = manifest.version;
