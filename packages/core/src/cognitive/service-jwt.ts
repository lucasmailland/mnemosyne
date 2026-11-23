import { sign as edSign, verify as edVerify, randomUUID, type KeyObject } from "node:crypto";

const MAX_EXP_HORIZON_SECONDS = 300; // 5 minutes

export interface ServiceJwtClaims {
  iss: string;
  sub: "federation";
  workspace_scope: string[];
  exp: number;
  iat: number;
  jti: string;
  aud: string;
}

export interface SignOptions {
  iss: string;
  aud: string;
  workspaceScope: string[];
  ttlSeconds?: number;
  jti?: string;
}

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

export function signServiceJwt(privateKey: KeyObject, opts: SignOptions): string {
  const iat = Math.floor(Date.now() / 1000);
  const claims: ServiceJwtClaims = {
    iss: opts.iss,
    sub: "federation",
    workspace_scope: opts.workspaceScope,
    iat,
    exp: iat + (opts.ttlSeconds ?? MAX_EXP_HORIZON_SECONDS),
    jti: opts.jti ?? randomUUID(),
    aud: opts.aud,
  };
  const header = b64url({ alg: "EdDSA", typ: "JWT" });
  const payload = b64url(claims);
  const signingInput = `${header}.${payload}`;
  const sig = edSign(null, Buffer.from(signingInput), privateKey).toString("base64url");
  return `${signingInput}.${sig}`;
}

export interface JtiStore {
  checkAndRecord(jti: string, expEpochSeconds: number): Promise<boolean>;
}

export class InMemoryJtiStore implements JtiStore {
  private readonly seen = new Map<string, number>();

  async checkAndRecord(jti: string, exp: number): Promise<boolean> {
    const now = Math.floor(Date.now() / 1000);
    // Evict expired entries
    for (const [k, e] of this.seen) {
      if (e < now) this.seen.delete(k);
    }
    if (this.seen.has(jti)) return false; // replay
    this.seen.set(jti, exp);
    return true;
  }
}

export interface VerifyOptions {
  publicKey: KeyObject;
  expectedAud: string;
  jtiStore: JtiStore;
  clockSkewSeconds?: number;
}

export type VerifyResult =
  | { ok: true; claims: ServiceJwtClaims }
  | { ok: false; reason: string };

export async function verifyServiceJwt(token: string, opts: VerifyOptions): Promise<VerifyResult> {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed JWT" };
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

  let header: { alg?: string };
  try {
    header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8")) as { alg?: string };
  } catch {
    return { ok: false, reason: "bad header" };
  }
  if (header.alg !== "EdDSA") return { ok: false, reason: `unsupported alg ${header.alg}` };

  const signingInput = `${headerB64}.${payloadB64}`;
  let sigOk = false;
  try {
    sigOk = edVerify(null, Buffer.from(signingInput), opts.publicKey, Buffer.from(sigB64, "base64url"));
  } catch {
    return { ok: false, reason: "signature verify error" };
  }
  if (!sigOk) return { ok: false, reason: "invalid signature" };

  let claims: ServiceJwtClaims;
  try {
    claims = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as ServiceJwtClaims;
  } catch {
    return { ok: false, reason: "bad payload" };
  }

  const skew = opts.clockSkewSeconds ?? 5;
  const now = Math.floor(Date.now() / 1000);

  if (claims.sub !== "federation") return { ok: false, reason: "sub must be 'federation'" };
  if (!Array.isArray(claims.workspace_scope)) return { ok: false, reason: "missing workspace_scope" };
  if (claims.aud !== opts.expectedAud) return { ok: false, reason: "aud mismatch" };
  if (typeof claims.exp !== "number" || claims.exp + skew < now) {
    return { ok: false, reason: "token expired" };
  }
  if (typeof claims.iat !== "number" || claims.exp - claims.iat > MAX_EXP_HORIZON_SECONDS) {
    return { ok: false, reason: "exp horizon exceeds 5 min" };
  }
  if (!claims.jti) return { ok: false, reason: "missing jti" };

  const fresh = await opts.jtiStore.checkAndRecord(claims.jti, claims.exp);
  if (!fresh) return { ok: false, reason: "jti replay rejected" };

  return { ok: true, claims };
}
