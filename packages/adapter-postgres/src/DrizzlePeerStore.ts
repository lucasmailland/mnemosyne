/**
 * DrizzlePeerStore — Postgres-backed PeerStore (packages/federation/src/MtlsAuthAdapter.ts)
 * over mnemo_federation_peer (migration 0061). Replaces InMemoryPeerStore, which
 * forgot every peer on restart.
 *
 * Like DrizzleSyncStorage, this file must NOT import from @mnemo-ai/federation
 * (circular dependency); PeerConfig is mirrored below and structural typing
 * satisfies the interface at the call site.
 *
 * Every call runs in its own transaction that downgrades to app_user when the
 * connection may (as withMnemoTx does) and sets the mnemosyne.federation_peers
 * GUC the table's only RLS policy checks.
 *
 * Secrets at rest: with a cipher (the server passes its MNEMO_MASTER_KEY key
 * ring), api_key and symmetric_key are stored as `enc:<blob>`, sealed under a
 * context bound to the peer and the column. Without one (dev, no master key)
 * they are stored as given, as webhook secrets are. A sealed value read without
 * a cipher throws instead of handing out the ciphertext.
 */

import { eq, sql } from "drizzle-orm";
import * as schema from "./schema/index.js";
import type { DrizzleClient } from "./DrizzleStorageAdapter.js";

/** Mirrors PeerConfig in packages/federation/src/MtlsAuthAdapter.ts. */
interface PeerConfig {
  peerId: string;
  pinnedCertDer: Uint8Array;
  trustWeight: number;
  approvedAt: string;
  enabled: boolean;
  url?: string;
  apiKey?: string;
  signingPublicKey?: string;
  symmetricKey?: string;
}

/** Seals and opens a secret; `context` must be bound into the ciphertext (AAD). */
export interface PeerSecretCipher {
  encrypt(context: string, plaintext: string): string;
  decrypt(context: string, blob: string): string;
}

type PeerRow = typeof schema.federationPeerTable.$inferSelect;
type Tx = Parameters<Parameters<DrizzleClient["transaction"]>[0]>[0];
type SecretColumn = "api_key" | "symmetric_key";

const peers = schema.federationPeerTable;
const SEALED = "enc:";

export class DrizzlePeerStore {
  constructor(
    private readonly db: DrizzleClient,
    private readonly cipher?: PeerSecretCipher
  ) {}

  private seal(peerId: string, column: SecretColumn, value: string | undefined): string | null {
    if (value === undefined) return null;
    if (!this.cipher) return value;
    return SEALED + this.cipher.encrypt(`federation-peer|${peerId}|${column}`, value);
  }

  private open(peerId: string, column: SecretColumn, stored: string | null): string | undefined {
    if (stored === null) return undefined;
    if (!stored.startsWith(SEALED)) return stored;
    if (!this.cipher) {
      throw new Error(`peer '${peerId}' ${column} is encrypted and no MNEMO_MASTER_KEY is set`);
    }
    return this.cipher.decrypt(`federation-peer|${peerId}|${column}`, stored.slice(SEALED.length));
  }

  private toConfig(row: PeerRow): PeerConfig {
    const apiKey = this.open(row.peerId, "api_key", row.apiKey);
    const symmetricKey = this.open(row.peerId, "symmetric_key", row.symmetricKey);
    return {
      peerId: row.peerId,
      pinnedCertDer: row.pinnedCertDer,
      trustWeight: row.trustWeight,
      approvedAt: row.approvedAt.toISOString(),
      enabled: row.enabled,
      ...(row.url !== null ? { url: row.url } : {}),
      ...(apiKey !== undefined ? { apiKey } : {}),
      ...(row.signingPublicKey !== null ? { signingPublicKey: row.signingPublicKey } : {}),
      ...(symmetricKey !== undefined ? { symmetricKey } : {}),
    };
  }

  private run<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      const member = (await tx.execute(
        sql`SELECT pg_has_role(current_user, 'app_user', 'member') AS m`
      )) as unknown as Array<{ m?: boolean }>;
      if (member[0]?.m) await tx.execute(sql`SET LOCAL ROLE app_user`);
      await tx.execute(sql`SELECT set_config('mnemosyne.federation_peers', 'on', true)`);
      return fn(tx);
    });
  }

  async get(peerId: string): Promise<PeerConfig | null> {
    const rows = await this.run((tx) => tx.select().from(peers).where(eq(peers.peerId, peerId)));
    return rows[0] ? this.toConfig(rows[0]) : null;
  }

  async list(): Promise<PeerConfig[]> {
    const rows = await this.run((tx) => tx.select().from(peers).orderBy(peers.peerId));
    return rows.map((row) => this.toConfig(row));
  }

  async addPeer(peer: PeerConfig): Promise<boolean> {
    const inserted = await this.run((tx) =>
      tx
        .insert(peers)
        .values({
          peerId: peer.peerId,
          pinnedCertDer: peer.pinnedCertDer,
          trustWeight: peer.trustWeight,
          approvedAt: new Date(peer.approvedAt),
          enabled: peer.enabled,
          url: peer.url ?? null,
          apiKey: this.seal(peer.peerId, "api_key", peer.apiKey),
          signingPublicKey: peer.signingPublicKey ?? null,
          symmetricKey: this.seal(peer.peerId, "symmetric_key", peer.symmetricKey),
        })
        .onConflictDoNothing()
        .returning({ peerId: peers.peerId })
    );
    return inserted.length > 0;
  }

  /** Key rotation for an EXISTING peer only (FED-04): an unknown peerId throws. */
  async upsertPinnedCert(peerId: string, certDer: Uint8Array, approvedAt: string): Promise<void> {
    const updated = await this.run((tx) =>
      tx
        .update(peers)
        .set({ pinnedCertDer: certDer, approvedAt: new Date(approvedAt) })
        .where(eq(peers.peerId, peerId))
        .returning({ peerId: peers.peerId })
    );
    if (updated.length === 0) {
      throw new Error(`unknown_peer: cannot pin cert for unprovisioned peer '${peerId}'`);
    }
  }

  async deletePeer(id: string): Promise<void> {
    await this.run((tx) => tx.delete(peers).where(eq(peers.peerId, id)));
  }
}
