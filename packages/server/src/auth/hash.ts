// Secret hashing for API keys (SECURITY.md §2.2 — "secret stored as Argon2id hash").
//
// New/rotated keys hash with argon2id. verifySecret auto-detects the stored
// algorithm by prefix so pre-existing bcrypt hashes keep verifying — gradual
// migration, no forced re-hash on existing keys.

import { hash as argonHash, verify as argonVerify } from "@node-rs/argon2";
import bcrypt from "bcrypt";

// OWASP-recommended argon2id params (m=19MiB, t=2, p=1).
// Algorithm.Argon2id === 2 but const enum is not accessible under isolatedModules.
const ARGON_OPTS = {
  algorithm: 2, // Argon2id
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashSecret(secret: string): Promise<string> {
  return argonHash(secret, ARGON_OPTS);
}

export async function verifySecret(secret: string, storedHash: string): Promise<boolean> {
  try {
    if (storedHash.startsWith("$argon2")) {
      return await argonVerify(storedHash, secret);
    }
    // Legacy bcrypt hash ($2a$/$2b$/$2y$) — constant-time compare internally.
    return await bcrypt.compare(secret, storedHash);
  } catch {
    return false;
  }
}
