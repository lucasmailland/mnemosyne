/**
 * A vendor export (`?from=mem0`) is a JSON array, and an uncompressed,
 * pretty-printed one has no parseable first line. It must get past the
 * "is this JSONL?" sniff and be read as the array it is.
 */
import { describe, it, expect } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";

import type { AuthVariables } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import { mountImport } from "../../routes/import-route.js";
import { toErrorBody } from "../../errors.js";

function buildApp() {
  const app = new OpenAPIHono<{ Variables: AuthVariables }>();
  app.use("*", async (c, next) => {
    c.set("workspaceId", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    c.set("scopes", ["memory:write"]);
    c.set("actorId", "agent-abc");
    c.set("userId", null);
    c.set("apiKeyPrefix", "mns_live_");
    await next();
  });
  app.onError((err, c) => {
    const { status, body } = toErrorBody(err);
    return c.json(body, status as 400);
  });
  mountImport(app, { storage: {} } as unknown as ServerDeps);
  return app;
}

const post = (path: string, body: string) =>
  buildApp().request(path, {
    method: "POST",
    headers: { "content-type": "application/gzip" },
    body,
  });

describe("POST /import — uncompressed bodies", () => {
  it("reads a pretty-printed vendor array instead of rejecting its first line", async () => {
    const res = await post("/import?from=mem0", "[\n]\n");
    // Past the sniff: an empty array is an empty import, not an unreadable body.
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ errors: 0 });
  });

  it("still rejects a body that is neither gzip nor JSONL", async () => {
    const res = await post("/import", "[\n]\n");
    const body = (await res.json()) as { error: { details?: { code?: string } } };
    expect(res.status).toBe(400);
    expect(body.error.details?.code).toBe("invalid_format");
  });
});

// APP-028 (audit 2026-11-22): measured live, a 261 KB gzip expanded to 256 MiB
// synchronously on the server (no output cap), and any real export over 1 MiB
// was refused by the global body limit although the route promises 100 MiB.
describe("POST /import — size limits", () => {
  it("refuses a body that decompresses past the cap, with 413", async () => {
    const { gzipSync } = await import("node:zlib");
    const prev = process.env["MNEMO_IMPORT_MAX_DECOMPRESSED_BYTES"];
    process.env["MNEMO_IMPORT_MAX_DECOMPRESSED_BYTES"] = String(1024 * 1024);
    try {
      const bomb = gzipSync(Buffer.alloc(8 * 1024 * 1024, 0x20));
      const res = await buildApp().request("/import", {
        method: "POST",
        headers: { "content-type": "application/gzip" },
        body: bomb,
      });
      expect(res.status).toBe(413);
    } finally {
      if (prev === undefined) delete process.env["MNEMO_IMPORT_MAX_DECOMPRESSED_BYTES"];
      else process.env["MNEMO_IMPORT_MAX_DECOMPRESSED_BYTES"] = prev;
    }
  });
});
