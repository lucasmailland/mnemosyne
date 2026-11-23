import { logger } from "../logging.js";
import { assertEncryptionAvailable } from "../encryption/assertEncryption.js";
import { KeyRingAdapter } from "../encryption/KeyRingAdapter.js";
import { GLOBAL_SENTINEL_ID } from "../config/WorkspaceConfigStore.js";
import type { PeerSecretCipher } from "@mnemo-ai/adapter-postgres";

/**
 * The cipher DrizzlePeerStore seals peer api_key/symmetric_key with: the
 * MNEMO_MASTER_KEY key ring under the instance sentinel, as instance settings
 * are. Undefined when encryption is off (dev without a master key); the boot
 * has already refused to start when it is required and missing.
 */
export function peerSecretCipherFromEnv(
  env: Record<string, string | undefined>
): PeerSecretCipher | undefined {
  if (assertEncryptionAvailable(env) !== "enabled") return undefined;
  const ring = new KeyRingAdapter({
    masterKeyHex: env["MNEMO_MASTER_KEY"]!,
    kekVersion: parseInt(env["MNEMO_KEK_VERSION"] ?? "1", 10),
  });
  return {
    encrypt: (context, plaintext) => ring.encryptSecret(GLOBAL_SENTINEL_ID, context, plaintext),
    decrypt: (context, blob) => ring.decryptSecret(GLOBAL_SENTINEL_ID, context, blob),
  };
}

export async function wireFederation(ctx: {
  databaseUrl: string;
  deps: import("../deps.js").ServerDeps;
  /** Defaults to process.env; tests boot two servers in one process. */
  env?: Record<string, string | undefined>;
}): Promise<void> {
  const { databaseUrl, deps } = ctx;
  const env = ctx.env ?? process.env;
  // Outside the try below: a misconfigured client certificate stops the boot
  // instead of leaving a server whose every pull fails at the peer's proxy.
  const { pullTlsFromEnv } = await import("../federation/federationIdentity.js");
  const pullTls = pullTlsFromEnv(env);
  // ---- Federation (optional peer dep) ----
  try {
    const fedMod = await import("@mnemo-ai/federation");
    const { InMemoryJobStore } = await import("../federation/JobStore.js");
    const { InMemoryJtiStore } = await import("@mnemo-ai/core");
    // Peers persist in mnemo_federation_peer (0061) and sync jobs in
    // mnemo_federation_sync_job (0063) when the Postgres adapter is installed;
    // otherwise they live in memory and a restart forgets them.
    let peerStore: import("@mnemo-ai/federation").PeerStore;
    let jobStore: import("../federation/JobStore.js").SyncJobStore;
    try {
      const pgMod = await import("@mnemo-ai/adapter-postgres");
      const cipher = peerSecretCipherFromEnv(env);
      const { db } = pgMod.createDrizzleClient(databaseUrl);
      peerStore = new pgMod.DrizzlePeerStore(db, cipher);
      jobStore = new pgMod.DrizzleSyncJobStore(db);
      logger.info(
        { secretsEncrypted: Boolean(cipher) },
        cipher
          ? "federation.peer_store=postgres"
          : "federation.peer_store=postgres — no MNEMO_MASTER_KEY, peer pull keys stored unencrypted"
      );
    } catch (peerStoreErr) {
      logger.warn(
        { err: peerStoreErr },
        "federation.peer_store=in_memory — peers and sync jobs are lost on restart"
      );
      peerStore = new fedMod.InMemoryPeerStore();
      jobStore = new InMemoryJobStore();
    }
    const mtls = new fedMod.MtlsAuthAdapter(peerStore);

    // §6 service-JWT replay defence: Redis-backed when MNEMO_REDIS_URL is set
    // so a jti seen by replica A is immediately rejected by replica B.
    // Falls back to InMemoryJtiStore (process-local replay protection only).
    let jtiStore: import("@mnemo-ai/core").JtiStore;
    const redisUrlForJti = env["MNEMO_REDIS_URL"];
    if (redisUrlForJti) {
      try {
        const { RedisJtiStore } = await import("../RedisJtiStore.js");
        jtiStore = new RedisJtiStore(redisUrlForJti);
        logger.info("federation.jti_store=redis");
      } catch {
        logger.warn(
          "federation.jti_store=in_memory (Redis JtiStore failed — multi-replica unsafe)"
        );
        jtiStore = new InMemoryJtiStore();
      }
    } else {
      logger.warn(
        "federation.jti_store=in_memory — set MNEMO_REDIS_URL for multi-replica replay protection"
      );
      jtiStore = new InMemoryJtiStore();
    }
    // Our federation id (MNEMO_FED_PEER_ID) is the aud peers sign for us; see
    // federation/authenticateFederationRequest.ts for the whole protocol.
    const selfAudience =
      env["MNEMO_FED_AUDIENCE"] ?? env["MNEMO_FED_PEER_ID"] ?? "mnemo:instance:self";
    const transport = {
      trustProxyHeaders: env["MNEMO_FED_TLS_PROXY"] === "true",
      allowInsecure: env["MNEMO_FED_INSECURE_TRANSPORT"] === "true",
      ...(env["MNEMO_TRUSTED_PROXY_IP"] ? { trustedProxyIp: env["MNEMO_TRUSTED_PROXY_IP"] } : {}),
    };
    if (transport.trustProxyHeaders && !transport.trustedProxyIp) {
      logger.warn(
        "federation.tls_proxy without MNEMO_TRUSTED_PROXY_IP — the proxy headers are trusted from any connection"
      );
    }
    if (transport.allowInsecure) {
      logger.warn("federation.insecure_transport — peers accepted over plain HTTP (dev only)");
    }
    let identity: import("../federation/federationIdentity.js").FederationIdentity | undefined;
    try {
      const { federationIdentityFromEnv } = await import("../federation/federationIdentity.js");
      identity = federationIdentityFromEnv(env);
    } catch (idErr) {
      logger.warn({ err: idErr }, "federation.identity_invalid — this server cannot pull");
    }
    if (!identity) {
      logger.info(
        "federation.identity=none — set MNEMO_FED_PEER_ID and MNEMO_FEDERATION_PRIVATE_KEY to pull"
      );
    }

    // SyncEngine requires a SyncStorage adapter and a SyncLogger.
    // Prefer DrizzleSyncStorage (persistent, survives restarts) when the
    // adapter-postgres package exposes it; fall back to InMemorySyncStorage
    // for deploys that don't have the adapter installed.
    let syncStorage: import("@mnemo-ai/federation").SyncStorage;
    try {
      const { DrizzleSyncStorage } = (await import("@mnemo-ai/adapter-postgres")) as {
        DrizzleSyncStorage?: new (db: unknown) => import("@mnemo-ai/federation").SyncStorage;
      };
      if (typeof DrizzleSyncStorage !== "function") {
        throw new Error("DrizzleSyncStorage not exported by @mnemo-ai/adapter-postgres");
      }
      const { db: syncDb } = (await import("@mnemo-ai/adapter-postgres")).createDrizzleClient(
        databaseUrl
      );
      syncStorage = new DrizzleSyncStorage(syncDb);
      logger.info("federation.sync_storage=drizzle");
    } catch (syncStorageErr) {
      logger.warn(
        { err: syncStorageErr },
        "federation.sync_storage=in_memory — DrizzleSyncStorage unavailable, using InMemorySyncStorage"
      );
      syncStorage = new fedMod.InMemorySyncStorage();
    }
    const syncLogger: import("@mnemo-ai/federation").SyncLogger = {
      warn: (msg, ctx) => logger.warn(ctx ?? {}, msg),
      info: (msg, ctx) => logger.info(ctx ?? {}, msg),
      debug: (msg, ctx) => logger.debug(ctx ?? {}, msg),
    };
    // workspaceId at the engine level is only a placeholder: a sync job writes
    // into the workspace that triggered it, through syncEngine.forWorkspace().
    const syncEngine = new fedMod.SyncEngine({
      storage: syncStorage,
      logger: syncLogger,
      workspaceId: "default",
    });

    // §20 app-layer crypto: serve-side keys from env (instance Ed25519 private
    // key PEM + shared 32-byte symmetric key, base64). Absent/invalid → plaintext
    // serve (transport mTLS + service-JWT still gate the endpoint). See P0-1.
    let serveCrypto: import("@mnemo-ai/federation").ServeCryptoKeys | undefined;
    const fedPrivPem = env["MNEMO_FEDERATION_PRIVATE_KEY"];
    const fedSymB64 = env["MNEMO_FEDERATION_SYMMETRIC_KEY"];
    if (fedPrivPem && fedSymB64) {
      try {
        const { createPrivateKey } = await import("node:crypto");
        const symmetricKey = Buffer.from(fedSymB64, "base64");
        if (symmetricKey.length !== 32) {
          throw new Error(
            `MNEMO_FEDERATION_SYMMETRIC_KEY must decode to 32 bytes (got ${symmetricKey.length})`
          );
        }
        serveCrypto = { instancePrivateKey: createPrivateKey(fedPrivPem), symmetricKey };
        logger.info("federation.serve_crypto=enabled");
      } catch (cryptoErr) {
        logger.warn({ err: cryptoErr }, "federation.serve_crypto_init_failed — serving plaintext");
      }
    }

    deps.federation = {
      peerStore,
      mtls,
      jobStore,
      syncEngine,
      jtiStore,
      selfAudience,
      transport,
      ...(identity ? { identity } : {}),
      ...(pullTls ? { pullTls } : {}),
      ...(serveCrypto ? { serveCrypto } : {}),
    };
    logger.info("federation.ready");
  } catch (err) {
    logger.warn({ err }, "federation.unavailable");
  }
}
