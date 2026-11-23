import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

import { KeyRingAdapter } from "../../encryption/KeyRingAdapter.js";
import {
  GLOBAL_SENTINEL_ID,
  type WorkspaceConfigStore,
} from "../../config/WorkspaceConfigStore.js";
import {
  INSTANCE_SETTING_KEYS,
  parsePublicBaseUrl,
  parseSettingsPatch,
  readInstanceSettings,
  writeInstanceSettings,
} from "../../instance-settings.js";
import { linkBaseUrl } from "../../single-use-link.js";

const cipher = new KeyRingAdapter({ masterKeyHex: "b".repeat(64), kekVersion: 1 });

/** In-memory store with the real store's group semantics. */
class MemoryStore implements WorkspaceConfigStore {
  rows = new Map<string, { value: string; updatedBy?: string }>();
  private k = (ws: string, key: string) => `${ws}|${key}`;
  async get(ws: string, key: string) {
    return this.rows.get(this.k(ws, key))?.value ?? null;
  }
  async set(ws: string, key: string, value: string, updatedBy?: string) {
    this.rows.set(this.k(ws, key), { value, updatedBy });
  }
  async delete(ws: string, key: string) {
    this.rows.delete(this.k(ws, key));
  }
  async getMany(ws: string, keys: readonly string[]) {
    const out = new Map<string, string>();
    for (const key of keys) {
      const v = this.rows.get(this.k(ws, key));
      if (v) out.set(key, v.value);
    }
    return out;
  }
  async replaceGroup(
    ws: string,
    group: readonly string[],
    values: Readonly<Record<string, string>>,
    updatedBy?: string
  ) {
    for (const key of group) if (!(key in values)) this.rows.delete(this.k(ws, key));
    for (const [key, value] of Object.entries(values))
      this.rows.set(this.k(ws, key), { value, updatedBy });
  }
}

describe("parsePublicBaseUrl", () => {
  it("accepts https and http://localhost, without trailing slashes", () => {
    expect(parsePublicBaseUrl("https://mnemo.example.test/")).toBe("https://mnemo.example.test");
    expect(parsePublicBaseUrl("  https://mnemo.example.test/base// ")).toBe(
      "https://mnemo.example.test/base"
    );
    expect(parsePublicBaseUrl("http://localhost:3000")).toBe("http://localhost:3000");
    expect(parsePublicBaseUrl("HTTPS://Mnemo.Example.Test")).toBe("https://mnemo.example.test");
  });

  it("refuses anything else", () => {
    for (const bad of [
      "http://mnemo.example.test",
      "http://localhost.evil.test",
      "ftp://mnemo.example.test",
      "javascript:alert(1)",
      "mnemo.example.test",
      "https://",
      "https://user:pass@mnemo.example.test",
      "https://mnemo.example.test/?q=1",
      "https://mnemo.example.test/#x",
      "",
      `https://${"a".repeat(2050)}.test`,
      42,
      null,
    ]) {
      expect(parsePublicBaseUrl(bad), String(bad)).toBeNull();
    }
  });
});

describe("parseSettingsPatch", () => {
  it("accepts either field, and null to clear the URL", () => {
    expect(parseSettingsPatch({ invitationsEnabled: false })).toEqual({
      ok: { invitationsEnabled: false },
    });
    expect(parseSettingsPatch({ publicBaseUrl: "https://a.example.test/" })).toEqual({
      ok: { publicBaseUrl: "https://a.example.test" },
    });
    expect(parseSettingsPatch({ publicBaseUrl: null })).toEqual({ ok: { publicBaseUrl: null } });
    expect(parseSettingsPatch({ workspaceLlmOverride: true })).toEqual({
      ok: { workspaceLlmOverride: true },
    });
  });

  it("refuses an empty patch, unknown or read-only fields and wrong types", () => {
    for (const bad of [
      {},
      null,
      [],
      "x",
      { registrationMode: "open" },
      { invitationsEnabled: "false" },
      { invitationsEnabled: true, other: 1 },
      { workspaceLlmOverride: "true" },
    ]) {
      expect(parseSettingsPatch(bad), JSON.stringify(bad)).toEqual({ error: "invalid_request" });
    }
    expect(parseSettingsPatch({ publicBaseUrl: "http://example.test" })).toEqual({
      error: "invalid_public_base_url",
    });
  });
});

describe("readInstanceSettings", () => {
  it("reports defaults when nothing is set", async () => {
    expect(await readInstanceSettings({}, { env: {} })).toEqual({
      invitationsEnabled: true,
      publicBaseUrl: null,
      registrationMode: "closed",
      workspaceLlmOverride: false,
      workspaceLimitPerUser: 5,
      source: {
        invitationsEnabled: "default",
        publicBaseUrl: "default",
        registrationMode: "default",
        workspaceLlmOverride: "default",
        workspaceLimitPerUser: "default",
      },
    });
  });

  it("workspaceLimitPerUser: 5 by default, from env when valid, a saved value wins", async () => {
    const store = new MemoryStore();
    const deps = { workspaceConfigStore: store };
    expect(
      await readInstanceSettings(deps, { env: { MNEMO_WORKSPACE_LIMIT_PER_USER: "2" }, cipher })
    ).toMatchObject({ workspaceLimitPerUser: 2, source: { workspaceLimitPerUser: "env" } });
    expect(
      await readInstanceSettings(deps, { env: { MNEMO_WORKSPACE_LIMIT_PER_USER: "-1" }, cipher })
    ).toMatchObject({ workspaceLimitPerUser: 5, source: { workspaceLimitPerUser: "default" } });
    await writeInstanceSettings(deps, { workspaceLimitPerUser: 0 }, "user:u1", { cipher });
    expect(
      await readInstanceSettings(deps, { env: { MNEMO_WORKSPACE_LIMIT_PER_USER: "2" }, cipher })
    ).toMatchObject({ workspaceLimitPerUser: 0, source: { workspaceLimitPerUser: "global" } });
  });

  it("parses the limit patch as a whole JSON number from 0 to 1000", () => {
    expect(parseSettingsPatch({ workspaceLimitPerUser: 7 })).toEqual({
      ok: { workspaceLimitPerUser: 7 },
    });
    for (const bad of [-1, 1.5, 1001, "5", null])
      expect(parseSettingsPatch({ workspaceLimitPerUser: bad }), String(bad)).toEqual({
        error: "invalid_request",
      });
  });

  it("workspaceLlmOverride: off by default, on from env, and a saved value wins", async () => {
    const store = new MemoryStore();
    const deps = { workspaceConfigStore: store };
    const env = { MNEMO_WORKSPACE_LLM_OVERRIDE: "true" };
    expect(await readInstanceSettings(deps, { env, cipher })).toMatchObject({
      workspaceLlmOverride: true,
      source: { workspaceLlmOverride: "env" },
    });
    await writeInstanceSettings(deps, { workspaceLlmOverride: false }, "user:u1", { cipher });
    expect(await readInstanceSettings(deps, { env, cipher })).toMatchObject({
      workspaceLlmOverride: false,
      source: { workspaceLlmOverride: "global" },
    });
    const saved = await store.get(GLOBAL_SENTINEL_ID, INSTANCE_SETTING_KEYS.workspaceLlmOverride);
    expect(cipher.decryptSecret(GLOBAL_SENTINEL_ID, "instance-settings", saved!)).toBe("false");
  });

  it("an unreadable saved workspaceLlmOverride keeps the model installation-only", async () => {
    const store = new MemoryStore();
    await store.set(
      GLOBAL_SENTINEL_ID,
      INSTANCE_SETTING_KEYS.workspaceLlmOverride,
      cipher.encryptSecret(GLOBAL_SENTINEL_ID, "instance-settings", "yes please")
    );
    expect(
      await readInstanceSettings({ workspaceConfigStore: store }, { env: {}, cipher })
    ).toMatchObject({ workspaceLlmOverride: false, source: { workspaceLlmOverride: "global" } });
  });

  it("reports env values with source env", async () => {
    const env = {
      MNEMO_INVITATIONS_ENABLED: "false",
      MNEMO_PUBLIC_BASE_URL: " https://env.example.test/ ",
    };
    expect(
      await readInstanceSettings({ workspaceConfigStore: new MemoryStore() }, { env, cipher })
    ).toMatchObject({
      invitationsEnabled: false,
      publicBaseUrl: "https://env.example.test",
      source: { invitationsEnabled: "env", publicBaseUrl: "env", registrationMode: "default" },
    });
  });

  it("ignores an unrecognised MNEMO_INVITATIONS_ENABLED", async () => {
    const view = await readInstanceSettings({}, { env: { MNEMO_INVITATIONS_ENABLED: "maybe" } });
    expect(view).toMatchObject({
      invitationsEnabled: true,
      source: { invitationsEnabled: "default" },
    });
  });

  it("a saved value wins over env, and clearing it brings env back", async () => {
    const store = new MemoryStore();
    const deps = { workspaceConfigStore: store };
    const env = {
      MNEMO_INVITATIONS_ENABLED: "true",
      MNEMO_PUBLIC_BASE_URL: "https://env.example.test",
    };
    await writeInstanceSettings(
      deps,
      { invitationsEnabled: false, publicBaseUrl: "https://saved.example.test" },
      "user:u1",
      { cipher }
    );
    expect(await readInstanceSettings(deps, { env, cipher })).toMatchObject({
      invitationsEnabled: false,
      publicBaseUrl: "https://saved.example.test",
      source: { invitationsEnabled: "global", publicBaseUrl: "global" },
    });

    await writeInstanceSettings(deps, { publicBaseUrl: null }, "user:u1", { cipher });
    expect(await readInstanceSettings(deps, { env, cipher })).toMatchObject({
      invitationsEnabled: false,
      publicBaseUrl: "https://env.example.test",
      source: { invitationsEnabled: "global", publicBaseUrl: "env" },
    });
  });

  it("stores values encrypted under the global sentinel and the instance-settings context", async () => {
    const store = new MemoryStore();
    await writeInstanceSettings(
      { workspaceConfigStore: store },
      { invitationsEnabled: false, publicBaseUrl: "https://saved.example.test" },
      "user:u1",
      { cipher }
    );
    const url = await store.get(GLOBAL_SENTINEL_ID, INSTANCE_SETTING_KEYS.publicBaseUrl);
    const inv = await store.get(GLOBAL_SENTINEL_ID, INSTANCE_SETTING_KEYS.invitationsEnabled);
    expect(url).not.toContain("saved.example.test");
    expect(cipher.decryptSecret(GLOBAL_SENTINEL_ID, "instance-settings", url!)).toBe(
      "https://saved.example.test"
    );
    expect(cipher.decryptSecret(GLOBAL_SENTINEL_ID, "instance-settings", inv!)).toBe("false");
    expect(store.rows.get(`${GLOBAL_SENTINEL_ID}|instance_public_base_url`)?.updatedBy).toBe(
      "user:u1"
    );
  });

  it("only touches the fields in the patch", async () => {
    const store = new MemoryStore();
    const deps = { workspaceConfigStore: store };
    await writeInstanceSettings(deps, { invitationsEnabled: false }, "user:u1", { cipher });
    await writeInstanceSettings(deps, { publicBaseUrl: "https://x.example.test" }, "user:u1", {
      cipher,
    });
    expect(await readInstanceSettings(deps, { env: {}, cipher })).toMatchObject({
      invitationsEnabled: false,
      publicBaseUrl: "https://x.example.test",
    });
  });

  it("a saved invitations value it cannot read counts as off", async () => {
    const store = new MemoryStore();
    await store.set(
      GLOBAL_SENTINEL_ID,
      INSTANCE_SETTING_KEYS.invitationsEnabled,
      cipher.encryptSecret(GLOBAL_SENTINEL_ID, "instance-settings", "garbage")
    );
    expect(
      await readInstanceSettings({ workspaceConfigStore: store }, { env: {}, cipher })
    ).toMatchObject({ invitationsEnabled: false, source: { invitationsEnabled: "global" } });
  });

  it("writing without a store is refused", async () => {
    await expect(
      writeInstanceSettings({}, { invitationsEnabled: false }, "user:u1", { cipher })
    ).rejects.toThrow(/unavailable/);
  });
});

describe("linkBaseUrl with the saved setting", () => {
  const baseOf = async (
    deps: Parameters<typeof linkBaseUrl>[1],
    env: Record<string, string | undefined>
  ) => {
    const app = new Hono();
    app.get("*", async (c) => c.text(await linkBaseUrl(c, deps, env)));
    return (await app.request("http://internal:8080/x")).text();
  };

  afterEach(() => vi.unstubAllEnvs());

  it("prefers the saved URL over env, then env, then the request origin", async () => {
    // The route reads the key ring from MNEMO_MASTER_KEY.
    vi.stubEnv("MNEMO_MASTER_KEY", "b".repeat(64));
    const store = new MemoryStore();
    const deps = { workspaceConfigStore: store };
    const env = { MNEMO_PUBLIC_BASE_URL: "https://env.example.test" };
    expect(await baseOf(deps, env)).toBe("https://env.example.test");
    await writeInstanceSettings(deps, { publicBaseUrl: "https://saved.example.test" }, "user:u1", {
      cipher,
    });
    expect(await baseOf(deps, env)).toBe("https://saved.example.test");
    expect(await baseOf({}, {})).toBe("http://internal:8080");
  });
});
