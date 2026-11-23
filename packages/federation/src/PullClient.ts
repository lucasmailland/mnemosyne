// Federation pull client — fetches FederatedItem[] from a remote peer.
//
// The remote peer exposes GET /memory/federation/items (see server routes/federation.ts).
// Authentication: Bearer <apiKey> (the mk_fed_ key that peer issued us). The
// peer's gate also wants our signed identity (x-mnemo-peer-id,
// x-mnemo-client-cert, x-mnemo-service-jwt); the server adds those through
// opts.injectHeaders (packages/server/src/federation/federationIdentity.ts).
//
// P0-1: when the peer is configured with a signing public key + shared symmetric
// key, the response body is a SecureItemsEnvelope (Ed25519-signed, AES-256-GCM
// per-item). pullFromPeer VERIFIES the signature and OPENS each payload, rejecting
// the whole batch on verify/decrypt failure — forged/tampered data never reaches
// the apply path. When no peer keys are configured (or the body is plaintext), it
// falls back to the legacy plaintext shape and logs a warning via the supplied
// logger, so existing deployments keep working.

import type { KeyObject } from "node:crypto";
import { get as httpsGet } from "node:https";
import type { FederatedItem } from "./SyncEngine.js";
import {
  isSecureEnvelope,
  openSecureItemsEnvelope,
  type SecureItemsEnvelope,
} from "./secureEnvelope.js";

/** Minimal logger surface (matches SyncLogger) so callers can pass theirs. */
export interface PullLogger {
  warn(msg: string, ctx?: Record<string, unknown>): void;
  debug?(msg: string, ctx?: Record<string, unknown>): void;
}

export interface PullOptions {
  /** ISO-8601 timestamp — only return items updated after this time (§20 incremental). */
  since?: string;
  /** Resume strictly after this point: the `nextCursor` of an earlier page. */
  cursor?: string;
  /**
   * Where the previous sync from this peer ended: the peer sends tombstones
   * only for facts that existed by then, the ones we may hold.
   */
  knownCursor?: string;
  /**
   * §20 scoped sync: knowledge types to request (e.g. ["fact","decision"]).
   * Sent to the peer as a `knowledgeTypes` query param; the peer's serve handler
   * filters. When omitted, the peer returns all federable types.
   */
  knowledgeTypes?: string[];
  /** Max items per pull. Defaults to 200. */
  limit?: number;
  /**
   * Peer signing public key (pinned, from PeerConfig.signingPublicKey).
   * When present together with `symmetricKey`, signature verification + payload
   * decryption are ENFORCED on a secure-envelope response.
   */
  peerSigningPublicKey?: KeyObject;
  /** Shared/derived 32-byte symmetric key for opening sealed item payloads. */
  symmetricKey?: Buffer;
  /**
   * F9 escape hatch: when peer keys ARE configured but the peer responds with a
   * plaintext (unsigned/unencrypted) body, the batch is REJECTED by default
   * (security downgrade). Set this to true to restore the legacy
   * accept-with-warning behavior during a mid-rollout migration. The boot path
   * sets it from MNEMO_FED_ALLOW_PLAINTEXT === "true".
   */
  allowPlaintextDowngrade?: boolean;
  /** Optional logger for the backward-compat downgrade warning. */
  logger?: PullLogger;
  /**
   * Optional function to inject outbound tracing headers (e.g. W3C traceparent).
   * Kept out of federation hex-core to avoid an @opentelemetry/* import here.
   * The server passes `injectTraceContext` from packages/server/src/telemetry/otel.ts.
   * Defaults to identity (no-op) when omitted.
   */
  injectHeaders?: (headers: Record<string, string>) => Record<string, string>;
  /**
   * TLS for https peers, PEM contents: a client certificate and its key to
   * present (a peer behind a proxy with `ssl_verify_client on` requires one),
   * and/or a CA that replaces the default roots for verifying the peer. The
   * server reads them from MNEMO_FED_CLIENT_CERT_FILE, MNEMO_FED_CLIENT_KEY_FILE
   * and MNEMO_FED_CA_FILE. Ignored for http:// peers.
   */
  tls?: PullTls;
}

export interface PullTls {
  cert?: string;
  key?: string;
  ca?: string;
}

export interface PullResult {
  items: FederatedItem[];
  /** Opaque cursor to resume after the page; null when the page was empty. */
  nextCursor: string | null;
  /** True when the batch arrived as a verified+decrypted secure envelope. */
  secure: boolean;
}

/**
 * Pull federated items from a remote peer's /memory/federation/items endpoint.
 *
 * Throws on:
 *   - network / non-OK HTTP response
 *   - signature verification failure (FederationVerifyError)
 *   - payload decryption failure (FederationDecryptError)
 *   - plaintext body when peer keys are configured (F9 downgrade reject),
 *     unless opts.allowPlaintextDowngrade (MNEMO_FED_ALLOW_PLAINTEXT) is set.
 *
 * The caller (federation sync job) catches and logs, leaving an empty batch.
 */
export async function pullFromPeer(
  peerUrl: string,
  apiKey: string,
  opts: PullOptions = {}
): Promise<PullResult> {
  const limit = opts.limit ?? 200;
  const params = new URLSearchParams({ limit: String(limit) });
  if (opts.since) params.set("since", opts.since);
  if (opts.cursor) params.set("cursor", opts.cursor);
  if (opts.knownCursor) params.set("knownCursor", opts.knownCursor);
  if (opts.knowledgeTypes && opts.knowledgeTypes.length > 0) {
    params.set("knowledgeTypes", opts.knowledgeTypes.join(","));
  }

  const url = `${peerUrl.replace(/\/$/, "")}/memory/federation/items?${params}`;

  const baseHeaders: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
  };
  const headers = opts.injectHeaders ? opts.injectHeaders(baseHeaders) : baseHeaders;

  const signal = AbortSignal.timeout(30_000);
  const res =
    opts.tls && url.startsWith("https:")
      ? await getWithTls(url, headers, opts.tls, signal)
      : await fetch(url, { method: "GET", headers, signal });

  if (!res.ok) {
    throw new Error(`Federation pull failed: ${res.status} ${res.statusText} from ${url}`);
  }

  const body = await readCappedJson(res);
  const keysConfigured = !!(opts.peerSigningPublicKey && opts.symmetricKey);

  // ── Secure path: signed + sealed envelope ──────────────────────────────────
  if (isSecureEnvelope(body)) {
    if (!keysConfigured) {
      // Peer is sending a secure envelope but we have no keys to verify/open it.
      // This is a misconfiguration, not a downgrade we can safely accept.
      throw new Error(
        "Federation pull received a secure envelope but no peer signing key / " +
          "symmetric key is configured — cannot verify or decrypt; rejecting batch"
      );
    }
    const opened = openSecureItemsEnvelope(body as SecureItemsEnvelope, {
      peerSigningPublicKey: opts.peerSigningPublicKey!,
      symmetricKey: opts.symmetricKey!,
    });
    return { items: opened.items, nextCursor: opened.nextCursor, secure: true };
  }

  // ── Plaintext shape ─────────────────────────────────────────────────────────
  // When keys ARE configured we expected a secure envelope; a plaintext body is
  // a security downgrade. F9: REJECT it by default — forged/unverified data must
  // not reach the apply path just because a peer stopped signing. Only accept it
  // when the operator has explicitly opted in via MNEMO_FED_ALLOW_PLAINTEXT
  // (threaded as opts.allowPlaintextDowngrade) for a controlled mid-rollout.
  if (keysConfigured) {
    if (!opts.allowPlaintextDowngrade) {
      throw new Error(
        "federation: peer keys configured but response was plaintext — rejecting " +
          "UNVERIFIED/UNENCRYPTED batch (security downgrade). Set " +
          "MNEMO_FED_ALLOW_PLAINTEXT=true to allow during migration."
      );
    }
    opts.logger?.warn(
      "federation: peer keys configured but response was plaintext — accepting " +
        "UNVERIFIED/UNENCRYPTED batch (MNEMO_FED_ALLOW_PLAINTEXT downgrade override)",
      { peerUrl }
    );
  } else {
    opts.logger?.debug?.("federation: pulling plaintext items (no peer crypto configured)", {
      peerUrl,
    });
  }

  const legacy = body as { items?: unknown[]; nextCursor?: string | null };
  const items = Array.isArray(legacy.items) ? (legacy.items as FederatedItem[]) : [];
  return { items, nextCursor: legacy.nextCursor ?? null, secure: false };
}

/**
 * Largest pull response accepted. A peer is authenticated but not trusted with
 * this process's memory: a bigger body is refused, not buffered.
 */
export const MAX_PULL_RESPONSE_BYTES = 32 * 1024 * 1024;

function tooLarge(): Error {
  return new Error(`Federation pull response exceeds ${MAX_PULL_RESPONSE_BYTES} bytes`);
}

/** The JSON body of a pull response, read up to MAX_PULL_RESPONSE_BYTES. */
async function readCappedJson(
  res: Pick<Response, "json"> & { body?: ReadableStream<Uint8Array> | null; headers?: Headers }
): Promise<unknown> {
  if (Number(res.headers?.get?.("content-length") ?? 0) > MAX_PULL_RESPONSE_BYTES) {
    throw tooLarge();
  }
  if (!res.body) return res.json(); // already buffered and capped (getWithTls)
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_PULL_RESPONSE_BYTES) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

/** GET over node:https, which (unlike fetch) takes a client certificate. */
function getWithTls(
  url: string,
  headers: Record<string, string>,
  tls: PullTls,
  signal: AbortSignal
): Promise<Pick<Response, "ok" | "status" | "statusText" | "json">> {
  return new Promise((resolve, reject) => {
    httpsGet(url, { headers, ...tls, signal }, (res) => {
      if (Number(res.headers["content-length"] ?? 0) > MAX_PULL_RESPONSE_BYTES) {
        res.destroy();
        return reject(tooLarge());
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_PULL_RESPONSE_BYTES) {
          res.destroy();
          reject(tooLarge());
          return;
        }
        chunks.push(chunk);
      });
      res.on("error", reject);
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        const status = res.statusCode ?? 0;
        resolve({
          ok: status >= 200 && status < 300,
          status,
          statusText: res.statusMessage ?? "",
          json: async () => JSON.parse(text) as unknown,
        });
      });
    }).on("error", reject);
  });
}
