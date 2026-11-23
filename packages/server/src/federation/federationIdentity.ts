// This server's federation identity and the headers it sends when it pulls.
//
// One id per server, MNEMO_FED_PEER_ID: the id other servers register us under
// (POST /memory/federation/peers), the `iss` of every service JWT we sign, and the
// `aud` we accept (unless MNEMO_FED_AUDIENCE overrides it). The signing key is
// MNEMO_FEDERATION_PRIVATE_KEY (Ed25519, PEM); peers pin its public key (SPKI).
// See authenticateFederationRequest.ts for the serving side of the protocol.

import { createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { createSecureContext } from "node:tls";
import { signServiceJwt } from "@mnemo-ai/core";
import type { PullTls } from "@mnemo-ai/federation";

export interface FederationIdentity {
  peerId: string;
  privateKey: KeyObject;
  /** Our public key, SPKI DER: what peers pin. */
  spkiDer: Uint8Array;
}

/**
 * The identity from env, or undefined when either variable is missing (this
 * server can still serve peers, but cannot pull). Throws on a malformed key.
 */
export function federationIdentityFromEnv(
  env: Record<string, string | undefined>
): FederationIdentity | undefined {
  const peerId = env["MNEMO_FED_PEER_ID"];
  const pem = env["MNEMO_FEDERATION_PRIVATE_KEY"];
  if (!peerId || !pem) return undefined;
  const privateKey = createPrivateKey(pem);
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("MNEMO_FEDERATION_PRIVATE_KEY must be an Ed25519 private key");
  }
  const spkiDer = new Uint8Array(
    createPublicKey(privateKey).export({ format: "der", type: "spki" })
  );
  return { peerId, privateKey, spkiDer };
}

/**
 * TLS for our pulls from https peers, from PEM files: MNEMO_FED_CLIENT_CERT_FILE
 * and MNEMO_FED_CLIENT_KEY_FILE (the client certificate a peer's proxy asks
 * for; it carries our federation key, see docs/architecture/MTLS_BOUNDARY.md)
 * and MNEMO_FED_CA_FILE (verifies peers instead of the default roots).
 * Undefined when none is set. Throws, so the server does not start, on a
 * certificate without its key or the reverse, an unreadable file, or a
 * certificate and key that do not parse or do not match.
 */
export function pullTlsFromEnv(env: Record<string, string | undefined>): PullTls | undefined {
  const certFile = env["MNEMO_FED_CLIENT_CERT_FILE"];
  const keyFile = env["MNEMO_FED_CLIENT_KEY_FILE"];
  const caFile = env["MNEMO_FED_CA_FILE"];
  if (!certFile && !keyFile && !caFile) return undefined;
  if (!certFile !== !keyFile) {
    throw new Error(
      "MNEMO_FED_CLIENT_CERT_FILE and MNEMO_FED_CLIENT_KEY_FILE go together: set both or neither"
    );
  }
  const read = (name: string, file: string) => {
    try {
      return readFileSync(file, "utf8");
    } catch (err) {
      throw new Error(`${name}: cannot read ${file} (${(err as Error).message})`);
    }
  };
  const tls: PullTls = {
    ...(certFile ? { cert: read("MNEMO_FED_CLIENT_CERT_FILE", certFile) } : {}),
    ...(keyFile ? { key: read("MNEMO_FED_CLIENT_KEY_FILE", keyFile) } : {}),
    ...(caFile ? { ca: read("MNEMO_FED_CA_FILE", caFile) } : {}),
  };
  try {
    createSecureContext(tls);
  } catch (err) {
    throw new Error(`federation client TLS files are not usable: ${(err as Error).message}`);
  }
  return tls;
}

/**
 * Headers proving to `servingPeerId` that this request comes from us: our id,
 * our public key, and a fresh service JWT for that peer only (aud = its id,
 * single use through its jti store, 60 s). The bearer mk_fed_ key the peer
 * issued us goes in Authorization, set by pullFromPeer.
 */
export function pullHeaders(
  identity: FederationIdentity,
  servingPeerId: string
): Record<string, string> {
  return {
    "x-mnemo-peer-id": identity.peerId,
    "x-mnemo-client-cert": Buffer.from(identity.spkiDer).toString("base64url"),
    "x-mnemo-service-jwt": signServiceJwt(identity.privateKey, {
      iss: identity.peerId,
      aud: servingPeerId,
      workspaceScope: [],
      ttlSeconds: 60,
    }),
  };
}
