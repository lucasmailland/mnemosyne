// Federation peer gate for the data plane (/items, /resolve).
//
// Protocol (what a pulling peer sends; see pullHeaders in federationIdentity.ts):
//   Authorization: Bearer <mk_fed_ key>   the key THIS server issued to the peer
//                                         (POST /admin/keys with federation: true).
//                                         The normal auth middleware resolves it to
//                                         a workspace and memory:federation.
//   x-mnemo-peer-id: <id>                 the id this server registered the peer
//                                         under (POST /memory/federation/peers).
//   x-mnemo-client-cert: <base64url>      the peer's public key (SPKI DER) or, behind
//                                         an mTLS proxy, the verified client cert the
//                                         proxy forwards: X.509 DER in base64url, or
//                                         the URL-encoded PEM nginx gives as
//                                         $ssl_client_escaped_cert. Compared with the pin.
//   x-mnemo-service-jwt: <EdDSA JWT>      iss = peer id, aud = this server's
//                                         MNEMO_FED_PEER_ID, fresh jti, exp <= 5 min,
//                                         signed with the peer's federation private key.
//
// The JWT signature, verified against the PINNED key, is the proof of possession:
// no header is trusted on its own. The TLS version is never taken from the client:
// it comes from this server's own TLS socket, or from x-mnemo-tls-protocol only
// when the operator declares a TLS-terminating proxy (MNEMO_FED_TLS_PROXY=true),
// which must overwrite that header and x-mnemo-client-cert on every request.
// With MNEMO_TRUSTED_PROXY_IP set, both headers count only on a connection whose
// socket address is that proxy: a client that reaches this server directly
// cannot claim TLS 1.3 or a certificate by writing the headers itself.
// MNEMO_FED_INSECURE_TRANSPORT=true (dev/test, refused in production) accepts a
// request with no TLS at all; every other check still runs.

import { createHash, createPublicKey, X509Certificate } from "node:crypto";
import { verifyServiceJwt, type JtiStore } from "@mnemo-ai/core";
import { assertFederationBinding, constantTimeEqual } from "@mnemo-ai/federation";

export interface FederationTransport {
  /** MNEMO_FED_TLS_PROXY=true: trust x-mnemo-tls-protocol from the TLS proxy. */
  trustProxyHeaders?: boolean;
  /** MNEMO_TRUSTED_PROXY_IP: the proxy headers count only from this socket address. */
  trustedProxyIp?: string;
  /** MNEMO_FED_INSECURE_TRANSPORT=true: accept plain HTTP (dev/test only). */
  allowInsecure?: boolean;
}

export interface FederationAuthDeps {
  peerStore: {
    get(peerId: string): Promise<{
      peerId: string;
      pinnedCertDer: Uint8Array;
      enabled: boolean;
    } | null>;
  };
  jtiStore: JtiStore;
  selfAudience: string;
  transport?: FederationTransport;
}

export type FederationAuthResult =
  | { ok: true; peerId: string; workspaceScope: string[] }
  | {
      ok: false;
      reason: string;
      /** p56: set ONLY on the cert-pin-mismatch branch. The other 6 failure
       *  reasons map to no declared AuditAction and leave these absent. */
      auditAction?: "federation_cert_pin_mismatch";
      peerId?: string;
      presentedCertFingerprint?: string; // SHA-256 hex, lowercase, no prefix
      pinnedCertFingerprint?: string;
    };

interface TlsSocketLike {
  encrypted?: boolean;
  getProtocol?: () => string | null;
  remoteAddress?: string;
}

function socketOf(c: { env?: unknown }): TlsSocketLike | undefined {
  return (c.env as { incoming?: { socket?: TlsSocketLike } } | undefined)?.incoming?.socket;
}

/** False when MNEMO_TRUSTED_PROXY_IP is set and this connection is not from it. */
function fromTrustedProxy(c: { env?: unknown }, transport: FederationTransport | undefined) {
  if (!transport?.trustedProxyIp) return true;
  // The socket, never X-Forwarded-For: a client writes that header itself.
  const remote = socketOf(c)?.remoteAddress?.replace(/^::ffff:/, "");
  return remote === transport.trustedProxyIp;
}

/** The TLS version this server knows was negotiated, or undefined. */
function negotiatedTls(
  c: { req: { header(k: string): string | undefined }; env?: unknown },
  transport: FederationTransport | undefined
): string | undefined {
  const socket = socketOf(c);
  if (socket?.encrypted) return socket.getProtocol?.() ?? undefined;
  if (transport?.trustProxyHeaders && fromTrustedProxy(c, transport)) {
    return c.req.header("x-mnemo-tls-protocol");
  }
  return undefined;
}

/**
 * x-mnemo-client-cert as bytes: base64url DER (a key or a cert), or the
 * URL-encoded PEM certificate nginx forwards ($ssl_client_escaped_cert).
 */
function decodeClientCertHeader(value: string): Uint8Array | undefined {
  if (!value.startsWith("-----BEGIN")) return new Uint8Array(Buffer.from(value, "base64url"));
  try {
    return new Uint8Array(new X509Certificate(decodeURIComponent(value)).raw);
  } catch {
    return undefined;
  }
}

/** The SPKI of a presented key: an X.509 cert's public key, or the bytes as given. */
function presentedSpki(der: Uint8Array): Uint8Array {
  try {
    return new Uint8Array(
      new X509Certificate(der).publicKey.export({ format: "der", type: "spki" })
    );
  } catch {
    return der;
  }
}

export async function authenticateFederationRequest(
  c: {
    req: { header(k: string): string | undefined };
    get(key: "apiKeyPrefix"): string | undefined;
    env?: unknown;
  },
  deps: FederationAuthDeps
): Promise<FederationAuthResult> {
  const peerId = c.req.header("x-mnemo-peer-id");
  const certHeader = fromTrustedProxy(c, deps.transport)
    ? c.req.header("x-mnemo-client-cert")
    : undefined;
  const token = c.req.header("x-mnemo-service-jwt")?.trim();
  const rawKeyType = c.get("apiKeyPrefix");
  const keyType = rawKeyType?.startsWith("mk_fed_") ? "mk_fed_" : rawKeyType;

  const clientCert = certHeader ? decodeClientCertHeader(certHeader) : undefined;

  const binding = assertFederationBinding({
    keyType,
    clientCert,
    tlsProtocol: negotiatedTls(c, deps.transport),
    allowInsecureTransport: deps.transport?.allowInsecure === true,
  });
  if (!binding.ok) return { ok: false, reason: binding.reason };
  if (!peerId) return { ok: false, reason: "missing peer id" };

  const peer = await deps.peerStore.get(peerId);
  if (!peer) return { ok: false, reason: "unknown peer" };
  if (!peer.enabled) return { ok: false, reason: "peer disabled" };

  // Cert pin comparison — constant-time, raw bytes
  if (!constantTimeEqual(peer.pinnedCertDer, presentedSpki(clientCert!))) {
    return {
      ok: false,
      reason: "cert pin mismatch",
      auditAction: "federation_cert_pin_mismatch",
      peerId,
      presentedCertFingerprint: certFingerprint(clientCert!),
      pinnedCertFingerprint: certFingerprint(peer.pinnedCertDer),
    };
  }

  if (!token) return { ok: false, reason: "missing service JWT" };

  let pubKey;
  try {
    pubKey = createPublicKey({ key: Buffer.from(peer.pinnedCertDer), format: "der", type: "spki" });
  } catch {
    return { ok: false, reason: "peer key parse error" };
  }

  const jwt = await verifyServiceJwt(token, {
    publicKey: pubKey,
    expectedAud: deps.selfAudience,
    jtiStore: deps.jtiStore,
  });
  if (!jwt.ok) return { ok: false, reason: jwt.reason };
  if (jwt.claims.iss !== peerId) return { ok: false, reason: "JWT issuer is not the peer" };

  return { ok: true, peerId, workspaceScope: jwt.claims.workspace_scope };
}

// ─── Fingerprint helper (p56) ───────────────────────────────────────────────
// SHA-256 hex digest, lowercase, no prefix — intentionally duplicates
// routes/federation.ts's module-private certFingerprint() rather than
// importing it: routes/federation.ts already imports this module, so an
// import in the other direction would create a cycle. Anti-drift is enforced
// by a parity test in federation-auth.test.ts.
function certFingerprint(der: Uint8Array): string {
  return createHash("sha256").update(der).digest("hex");
}
