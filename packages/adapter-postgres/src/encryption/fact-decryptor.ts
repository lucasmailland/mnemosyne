// Read side of fact column encryption (SECURITY.md §7).
//
// Every fact read the storage adapter returns goes through `openFacts`: a
// `confidential`/`restricted` row's `statement`/`subject` hold "enc:v1:"
// ciphertext under the DEK of the actor that wrote the row (`actor_id`), and
// the caller that passed the sensitivity check is owed the text, not the
// ciphertext.
//
// One DEK lookup per call for all distinct actors in the batch, unwrapped once
// per actor (the per-request cache). Nothing is cached across calls: a key
// destroyed by crypto-erasure must stop opening rows on the very next read.
//
// A row that cannot be opened is returned with a placeholder and a flag,
// never with its ciphertext and never as an error that fails the whole read:
//   - "erased"     — the actor's DEK was destroyed (POST /admin/erasure,
//                    forget hard mode, the retention cron).
//   - "unreadable" — no unwrapper is configured (MNEMO_MASTER_KEY unset), the
//                    DEK row is missing, or the key does not open the
//                    ciphertext (wrong master key or tampered row).

import { and, eq, inArray, sql } from "drizzle-orm";
import type { FactRedaction } from "@mnemo-ai/types";
import * as schema from "../schema/index.js";
import type { DrizzleClient, DekUnwrapper } from "../repositories/types.js";
import { decryptEncryptedField, isEncryptedField } from "./fact-cryptor.js";

export const REDACTED_TEXT: Record<FactRedaction, string> = {
  erased: "[erased]",
  unreadable: "[unreadable]",
};

interface SealedFact {
  statement: string;
  subject?: string | undefined;
  actorId?: string | null | undefined;
}

export async function openFacts<T extends SealedFact>(
  db: DrizzleClient,
  unwrap: DekUnwrapper | undefined,
  workspaceId: string,
  items: T[]
): Promise<Array<T & { redacted?: FactRedaction }>> {
  const sealed = (f: SealedFact) =>
    isEncryptedField(f.statement) || (f.subject !== undefined && isEncryptedField(f.subject));
  if (!items.some(sealed)) return items;
  const actorIds = [
    ...new Set(items.filter(sealed).flatMap((f) => (f.actorId ? [f.actorId] : []))),
  ];

  // actorId → DEK, or the reason there is none. Absent = no DEK row.
  const keys = new Map<string, Buffer | FactRedaction>();
  if (unwrap && actorIds.length > 0) {
    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      return tx
        .select({
          actorId: schema.actorDekTable.actorId,
          status: schema.actorDekTable.status,
          encryptedKey: schema.actorDekTable.encryptedKey,
        })
        .from(schema.actorDekTable)
        .where(
          and(
            eq(schema.actorDekTable.workspaceId, workspaceId),
            inArray(schema.actorDekTable.actorId, actorIds)
          )
        );
    });
    for (const row of rows) {
      const raw = row.encryptedKey as unknown;
      const wrapped = raw instanceof Uint8Array ? Buffer.from(raw).toString("base64") : raw;
      if (row.status !== "active" || typeof wrapped !== "string") {
        keys.set(row.actorId, "erased");
        continue;
      }
      try {
        keys.set(row.actorId, unwrap(workspaceId, row.actorId, wrapped));
      } catch (err) {
        console.warn(
          `[facts] fact.dek_unwrap_failed workspaceId=${workspaceId} actorId=${row.actorId}: ${String(err)}`
        );
        keys.set(row.actorId, "unreadable");
      }
    }
  }

  return items.map((item) => {
    if (!sealed(item)) return item;
    let reason: FactRedaction = "unreadable";
    const key = item.actorId ? keys.get(item.actorId) : undefined;
    if (Buffer.isBuffer(key)) {
      try {
        return {
          ...item,
          statement: decryptEncryptedField(key, item.statement),
          ...(item.subject !== undefined
            ? { subject: decryptEncryptedField(key, item.subject) }
            : {}),
        };
      } catch (err) {
        console.warn(
          `[facts] fact.decrypt_failed workspaceId=${workspaceId} actorId=${item.actorId}: ${String(err)}`
        );
      }
    } else if (key) {
      reason = key;
    }
    const text = REDACTED_TEXT[reason];
    return {
      ...item,
      statement: text,
      ...(item.subject !== undefined ? { subject: text } : {}),
      redacted: reason,
    };
  });
}
