/**
 * APP-026 (audit 2026-11-22): every well-formed but unknown key fell through to
 * an O(n) bcrypt loop over EVERY active key (cost 12, ~250 ms each on the
 * threadpool), before any rate limit runs. A stream of random tokens starved
 * authentication for everyone. The fallback exists only for keys minted before
 * lookup hashes (migration 0064); a key that has one can never match there.
 */
import bcrypt from "bcrypt";
import { afterEach, describe, expect, it, vi } from "vitest";

import { verifyApiKeyToken, type ApiKeyLookup } from "../../auth.js";

afterEach(() => vi.restoreAllMocks());

function lookupWith(rows: Array<{ id: string; keyHash: string; hasLookupHash?: boolean }>) {
  const listActive = vi.fn(async () =>
    rows.map((r) => ({ ...r, workspaceId: "11111111-1111-4111-8111-111111111111", scopes: ["memory:read"] }))
  );
  return {
    listActive,
    lookup: {
      listActive,
      findByLookupHash: async () => null,
      setLookupHash: async () => undefined,
      touch: async () => undefined,
    } as unknown as ApiKeyLookup,
  };
}

describe("unknown keys do not cost a bcrypt per active key", () => {
  it("does not compare against keys that have a lookup hash", async () => {
    const compare = vi.spyOn(bcrypt, "compare");
    const { lookup } = lookupWith([
      { id: "a", keyHash: "$2b$04$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", hasLookupHash: true },
      { id: "b", keyHash: "$2b$04$bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", hasLookupHash: true },
    ]);
    expect(await verifyApiKeyToken(lookup, "mns_live_randomrandomrandom01")).toBeNull();
    expect(compare).not.toHaveBeenCalled();
  });

  it("still finds a legacy key that has no lookup hash yet", async () => {
    const legacy = "mns_live_legacylegacylegacy01";
    const { lookup } = lookupWith([{ id: "old", keyHash: await bcrypt.hash(legacy, 4) }]);
    expect((await verifyApiKeyToken(lookup, legacy))?.actorId).toBe("old");
  });

  it("does not repeat the fallback for a token that just failed", async () => {
    const { lookup, listActive } = lookupWith([{ id: "old", keyHash: await bcrypt.hash("mns_live_other0000000000000", 4) }]);
    const bad = "mns_live_samebadtoken000000001";
    expect(await verifyApiKeyToken(lookup, bad)).toBeNull();
    expect(await verifyApiKeyToken(lookup, bad)).toBeNull();
    expect(await verifyApiKeyToken(lookup, bad)).toBeNull();
    expect(listActive).toHaveBeenCalledTimes(1);
  });
});

describe("final review I3: changing MNEMO_KEY_PEPPER does not lock every key out", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("finds a key hashed under MNEMO_KEY_PEPPER_PREVIOUS and re-keys it to the current pepper", async () => {
    const { createHmac } = await import("node:crypto");
    const token = "mns_live_peppermovedpeppermoved01";
    const oldHash = createHmac("sha256", "old-pepper").update(token).digest("hex");
    const newHash = createHmac("sha256", "new-pepper").update(token).digest("hex");
    const row = {
      id: "k1",
      keyHash: await bcrypt.hash(token, 4),
      workspaceId: "11111111-1111-4111-8111-111111111111",
      scopes: ["memory:read"],
      hasLookupHash: true,
    };
    const setLookupHash = vi.fn(async () => undefined);
    const lookup = {
      listActive: async () => [row],
      findByLookupHash: async (h: string) => (h === oldHash ? row : null),
      setLookupHash,
      touch: async () => undefined,
    } as unknown as ApiKeyLookup;

    process.env.MNEMO_KEY_PEPPER = "new-pepper";
    process.env.MNEMO_KEY_PEPPER_PREVIOUS = "old-pepper";
    expect((await verifyApiKeyToken(lookup, token))?.actorId).toBe("k1");
    await new Promise((r) => setImmediate(r));
    expect(setLookupHash).toHaveBeenCalledWith("k1", newHash);
  });
});
