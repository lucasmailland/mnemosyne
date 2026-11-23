/// <reference types="node" />
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { isUuid, resolveWorkspace } = require("../../../../../docker/scripts/create-api-key.cjs");

const UUID_EXAMPLE = "bd293fa7-cc0d-4773-b3c4-c241599b109b";

describe("create-api-key workspace handling", () => {
  it("generates a UUID when --workspace is omitted", () => {
    const ws = resolveWorkspace(undefined);
    expect(isUuid(ws)).toBe(true);
  });

  it("generates a UUID when --workspace is empty string", () => {
    const ws = resolveWorkspace("");
    expect(isUuid(ws)).toBe(true);
  });

  it("accepts a valid UUID as-is", () => {
    expect(resolveWorkspace(UUID_EXAMPLE)).toBe(UUID_EXAMPLE);
  });

  it("rejects a non-UUID workspace with a descriptive error", () => {
    expect(() => resolveWorkspace("ws_default")).toThrow(/uuid/i);
  });

  it("rejects a CUID workspace", () => {
    expect(() => resolveWorkspace("tvlds3k623us6sz7zp2ek6gh")).toThrow(/uuid/i);
  });

  it("isUuid correctly identifies UUIDs", () => {
    expect(isUuid(UUID_EXAMPLE)).toBe(true);
    expect(isUuid("ws_default")).toBe(false);
    expect(isUuid("tvlds3k623us6sz7zp2ek6gh")).toBe(false);
    expect(isUuid("not-a-uuid")).toBe(false);
  });
});

// APP-050 (audit 2026-11-22): the README's key script inserted only the key.
// Its workspace had no mnemo_workspace row, so memory_workspace answered 404
// for the key's own workspace, memory_context showed name null / role null and
// the dashboard listed no workspace. A new workspace is created with the key,
// the way POST /bootstrap creates it.
describe("create-api-key registers the workspace with the key", () => {
  const { registerKey } = require("../../../../../docker/scripts/create-api-key.cjs");

  function fakeSql(existingWorkspace: boolean) {
    const statements: string[] = [];
    const run = (tpl: TemplateStringsArray) => {
      const q = tpl.join("?").replace(/\s+/g, " ").trim().toLowerCase();
      statements.push(q);
      if (q.includes("from mnemosyne.mnemo_workspace")) return Promise.resolve(existingWorkspace ? [{ id: "w" }] : []);
      return Promise.resolve([]);
    };
    const sql = Object.assign(run, {
      array: (v: unknown) => v,
      begin: async (fn: (tx: unknown) => Promise<unknown>) => fn(Object.assign(run, { array: (v: unknown) => v })),
    });
    return { sql, statements };
  }
  const input = {
    keyId: "key_1",
    workspaceId: UUID_EXAMPLE,
    hashed: "$2b$12$x",
    lookupHash: "h",
    label: "my laptop",
    scopes: ["memory:read"],
  };

  it("creates the tenant and workspace in the same transaction as the key", async () => {
    const { sql, statements } = fakeSql(false);
    await registerKey(sql, input);
    const inserts = statements.filter((s) => s.startsWith("insert into")).map((s) => s.split(" ")[2]);
    expect(inserts).toEqual(["mnemosyne.mnemo_tenant", "mnemosyne.mnemo_workspace", "mnemosyne.mnemo_api_keys"]);
  });

  it("only adds the key when the workspace already exists (--workspace)", async () => {
    const { sql, statements } = fakeSql(true);
    await registerKey(sql, input);
    const inserts = statements.filter((s) => s.startsWith("insert into")).map((s) => s.split(" ")[2]);
    expect(inserts).toEqual(["mnemosyne.mnemo_api_keys"]);
  });
});

describe("APP-040: the first key can manage keys in the dashboard", () => {
  it("the README's key and the first-claim key carry admin:keys with memory:admin", async () => {
    const { MINTED_SCOPES } = require("../../../../../docker/scripts/create-api-key.cjs");
    expect(MINTED_SCOPES).toEqual(expect.arrayContaining(["admin:keys", "memory:admin"]));
    const { FIRST_KEY_SCOPES } = await import("../../routes/bootstrap.js");
    expect(FIRST_KEY_SCOPES).toEqual(expect.arrayContaining(["admin:keys", "memory:admin"]));
  });
});
