// RFC 6238 TOTP (HMAC-SHA1, 6 digits, 30s step) for mk_admin_ break-glass MFA.
// Pure stdlib crypto — no external otp library.

import { createHmac, randomBytes } from "node:crypto";

const STEP_SECONDS = 30;
const DIGITS = 6;
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** A fresh 160-bit shared secret (RFC 4226 §4), base32 without padding. */
export function generateTotpSecret(): string {
  let bits = "";
  for (const b of randomBytes(20)) bits += b.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i < bits.length; i += 5) out += BASE32[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}

function base32Decode(b32: string): Buffer {
  const alphabet = BASE32;
  const clean = b32.replace(/=+$/, "").toUpperCase();
  let bits = "";
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) continue;
    bits += idx.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

function hotp(secret: Buffer, counter: number): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", secret).update(buf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const bin =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  return (bin % 10 ** DIGITS).toString().padStart(DIGITS, "0");
}

export function generateTotp(base32Secret: string, at: Date = new Date()): string {
  const counter = Math.floor(at.getTime() / 1000 / STEP_SECONDS);
  return hotp(base32Decode(base32Secret), counter);
}

/** Verifies with ±1 step skew tolerance. */
export function verifyTotp(base32Secret: string, code: string, at: Date = new Date()): boolean {
  const secret = base32Decode(base32Secret);
  const counter = Math.floor(at.getTime() / 1000 / STEP_SECONDS);
  for (const c of [counter, counter - 1, counter + 1]) {
    if (hotp(secret, c) === code) return true;
  }
  return false;
}
