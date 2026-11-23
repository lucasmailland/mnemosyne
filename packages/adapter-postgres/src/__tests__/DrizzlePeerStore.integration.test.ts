/**
 * Integration test: DrizzlePeerStore over mnemo_federation_peer (migration 0061).
 *
 * Boots a real pgvector container, applies every migration and checks the
 * PeerStore contract the federation routes rely on: add (no duplicate), get,
 * list, key rotation only for an existing peer (FED-04), delete, and that the
 * table's RLS hides peers from any query that has not set the store's GUC.
 * Runs via `test:integration` (needs Docker).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { createDrizzleClient } from "../DrizzleStorageAdapter.js";
import { DrizzlePeerStore } from "../DrizzlePeerStore.js";
import { migrate } from "../migrate.js";

const PG_IMAGE = "pgvector/pgvector:pg17";

// Stand-in for the server's key ring (tested in federation-peer-cipher.test.ts):
// reversible, and refuses a blob opened under another context.
const FAKE_CIPHER = {
  encrypt: (context: string, plaintext: string) =>
    Buffer.from(`${context}\0${plaintext}`).toString("base64").split("").reverse().join(""),
  decrypt: (context: string, blob: string) => {
    const [ctx, plaintext] = Buffer.from(blob.split("").reverse().join(""), "base64")
      .toString()
      .split("\0");
    if (ctx !== context) throw new Error("context mismatch");
    return plaintext!;
  },
};

let container: StartedTestContainer;
let store: DrizzlePeerStore;
let sealedStore: DrizzlePeerStore;
let pg: { end: () => Promise<void> };
let raw: ReturnType<typeof postgres>;

beforeAll(async () => {
  container = await new GenericContainer(PG_IMAGE)
    .withEnvironment({
      POSTGRES_USER: "mnemo_test",
      POSTGRES_PASSWORD: "mnemo_test",
      POSTGRES_DB: "mnemo_test",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
    .start();
  const url = `postgres://mnemo_test:mnemo_test@${container.getHost()}:${container.getMappedPort(5432)}/mnemo_test`;
  await migrate({ databaseUrl: url, log: () => {} });
  const { db, pgClient } = createDrizzleClient(url);
  store = new DrizzlePeerStore(db);
  sealedStore = new DrizzlePeerStore(db, FAKE_CIPHER);
  pg = pgClient as unknown as { end: () => Promise<void> };
  raw = postgres(url, { onnotice: () => void 0, max: 1 });
}, 120_000);

afterAll(async () => {
  await raw?.end().catch(() => void 0);
  await pg?.end?.();
  await container?.stop();
});

const CERT = new Uint8Array([0x30, 0x2a, 0x00, 0xff, 0x10]);

describe("DrizzlePeerStore", () => {
  it("addPeer persists every PeerConfig field and get returns it", async () => {
    const added = await store.addPeer({
      peerId: "acme.example",
      pinnedCertDer: CERT,
      trustWeight: 0.6,
      approvedAt: "2026-01-02T03:04:05.000Z",
      enabled: true,
      url: "https://acme.example",
      apiKey: "mk_fed_fixture",
      signingPublicKey: "fixture-pem",
      symmetricKey: Buffer.alloc(32, 1).toString("base64"),
    });
    expect(added).toBe(true);

    const got = await store.get("acme.example");
    expect(got).not.toBeNull();
    expect(Array.from(got!.pinnedCertDer)).toEqual(Array.from(CERT));
    expect(got).toMatchObject({
      peerId: "acme.example",
      trustWeight: 0.6,
      approvedAt: "2026-01-02T03:04:05.000Z",
      enabled: true,
      url: "https://acme.example",
      apiKey: "mk_fed_fixture",
      signingPublicKey: "fixture-pem",
    });
  });

  it("addPeer on an existing peerId returns false and keeps the original", async () => {
    const again = await store.addPeer({
      peerId: "acme.example",
      pinnedCertDer: new Uint8Array([1]),
      trustWeight: 1,
      approvedAt: "2026-02-01T00:00:00.000Z",
      enabled: false,
    });
    expect(again).toBe(false);
    expect((await store.get("acme.example"))?.trustWeight).toBe(0.6);
  });

  it("omits unset optional fields and lists peers by id", async () => {
    await store.addPeer({
      peerId: "larkspur.example",
      pinnedCertDer: CERT,
      trustWeight: 0,
      approvedAt: "2026-01-01T00:00:00.000Z",
      enabled: false,
    });
    const larkspur = await store.get("larkspur.example");
    expect(larkspur).not.toHaveProperty("url");
    expect(larkspur).not.toHaveProperty("apiKey");
    expect((await store.list()).map((p) => p.peerId)).toEqual(["acme.example", "larkspur.example"]);
  });

  it("upsertPinnedCert rotates an existing peer's pin", async () => {
    await store.upsertPinnedCert(
      "acme.example",
      new Uint8Array([9, 9]),
      "2026-03-01T00:00:00.000Z"
    );
    const got = await store.get("acme.example");
    expect(Array.from(got!.pinnedCertDer)).toEqual([9, 9]);
    expect(got!.approvedAt).toBe("2026-03-01T00:00:00.000Z");
  });

  it("upsertPinnedCert never creates a peer (FED-04)", async () => {
    await expect(
      store.upsertPinnedCert("intruder.example", CERT, "2026-03-01T00:00:00.000Z")
    ).rejects.toThrow(/unknown_peer/);
    expect(await store.get("intruder.example")).toBeNull();
  });

  it("a query without the store's GUC sees no peers (RLS)", async () => {
    const rows = await raw.begin(async (tx) => {
      await tx`SET LOCAL ROLE app_user`;
      return tx`SELECT peer_id FROM mnemosyne.mnemo_federation_peer`;
    });
    expect(rows).toHaveLength(0);
  });

  it("deletePeer removes the peer", async () => {
    await store.deletePeer("larkspur.example");
    expect(await store.get("larkspur.example")).toBeNull();
  });
});

describe("DrizzlePeerStore with a cipher", () => {
  const sym = Buffer.alloc(32, 3).toString("base64");

  it("stores api_key and symmetric_key sealed and reads them back in the clear", async () => {
    await sealedStore.addPeer({
      peerId: "sealed.example",
      pinnedCertDer: CERT,
      trustWeight: 0.5,
      approvedAt: "2026-01-01T00:00:00.000Z",
      enabled: true,
      apiKey: "mk_fed_sealed_fixture",
      symmetricKey: sym,
    });
    const [row] = await raw`
      SELECT api_key, symmetric_key FROM mnemosyne.mnemo_federation_peer
      WHERE peer_id = 'sealed.example'`;
    expect(row!["api_key"]).toMatch(/^enc:/);
    expect(row!["symmetric_key"]).toMatch(/^enc:/);
    expect(JSON.stringify(row)).not.toContain("mk_fed_sealed_fixture");
    expect(JSON.stringify(row)).not.toContain(sym);

    const got = await sealedStore.get("sealed.example");
    expect(got).toMatchObject({ apiKey: "mk_fed_sealed_fixture", symmetricKey: sym });
  });

  it("a store without the cipher refuses sealed secrets instead of handing out ciphertext", async () => {
    await expect(store.get("sealed.example")).rejects.toThrow(/encrypted/);
  });

  it("still reads a secret stored unencrypted (written before a master key was set)", async () => {
    expect((await sealedStore.get("acme.example"))?.apiKey).toBe("mk_fed_fixture");
  });
});
