#!/usr/bin/env node
/**
 * mnemo-mock bin entry point.
 * Usage: npx @mnemo-ai/mock-server [--port 3999]
 */

import { createMockApp } from "./app.js";

const portArg = process.argv.find((a) => a.startsWith("--port="))?.split("=")[1];
const port = portArg ? parseInt(portArg, 10) : 3999;

createMockApp(port)
  .then(({ port: bound }) => {
    process.stdout.write(`mnemo-mock server running on http://127.0.0.1:${bound}\n`);
    process.stdout.write("All requests return deterministic fixture data (no DB required).\n");
  })
  .catch((err: unknown) => {
    process.stderr.write(`[mnemo-mock] Error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
