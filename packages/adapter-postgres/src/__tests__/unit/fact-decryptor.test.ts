/**
 * The read side of fact column encryption: `openFacts` decrypts with the DEK
 * of each row's actor, and never returns ciphertext when it cannot.
 * The database is a stub that answers the one mnemo_actor_dek SELECT.
 */
import { describe, it, expect, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { encryptPiiColumns } from "../../encryption/fact-cryptor.js";
import { openFacts } from "../../encryption/fact-decryptor.js";
import type { DrizzleClient } from "../../repositories/types.js";

const WS = "00000000-0000-4000-8000-000000000001";
type DekRow = { actorId: string; status: string; encryptedKey: Buffer | null };

function stubDb(rows: DekRow[]) {
  const lookups = vi.fn(async () => rows);
  const tx = {
    execute: async () => undefined,
    select: () => ({ from: () => ({ where: lookups }) }),
  };
  const db = {
    transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  } as unknown as DrizzleClient;
  return { db, lookups };
}

const unwrap = (_ws: string, _actor: string, wrapped: string) => Buffer.from(wrapped, "base64");

function sealedFact(id: string, actorId: string, dek: Buffer, statement: string) {
  return {
    id,
    actorId,
    ...encryptPiiColumns(dek, "dek", { statement, subject: "acme", sensitivity: "confidential" }),
  };
}

describe("openFacts", () => {
  it("decrypts each row with its actor's DEK, one lookup per call", async () => {
    const a = randomBytes(32);
    const b = randomBytes(32);
    const { db, lookups } = stubDb([
      { actorId: "key:a", status: "active", encryptedKey: a },
      { actorId: "key:b", status: "active", encryptedKey: b },
    ]);
    const out = await openFacts(db, unwrap, WS, [
      sealedFact("1", "key:a", a, "Acme payroll runs Fridays"),
      sealedFact("2", "key:b", b, "Larkspur Robotics owes 40k"),
      sealedFact("3", "key:a", a, "Acme bank is in Lisbon"),
      { id: "4", actorId: "key:c", statement: "plain internal text", subject: "acme" },
    ]);
    expect(out.map((f) => f.statement)).toEqual([
      "Acme payroll runs Fridays",
      "Larkspur Robotics owes 40k",
      "Acme bank is in Lisbon",
      "plain internal text",
    ]);
    expect(out.every((f) => f.subject === "acme" && !("redacted" in f))).toBe(true);
    expect(lookups).toHaveBeenCalledTimes(1);
  });

  it("marks a destroyed key as erased, never returning ciphertext", async () => {
    const dek = randomBytes(32);
    const { db } = stubDb([{ actorId: "key:a", status: "destroyed", encryptedKey: null }]);
    const [f] = await openFacts(db, unwrap, WS, [sealedFact("1", "key:a", dek, "secret")]);
    expect(f).toMatchObject({ statement: "[erased]", subject: "[erased]", redacted: "erased" });
  });

  it("marks rows unreadable without an unwrapper, without a DEK row, or under the wrong key", async () => {
    const dek = randomBytes(32);
    const fact = sealedFact("1", "key:a", dek, "secret");
    const noUnwrapper = await openFacts(stubDb([]).db, undefined, WS, [fact]);
    const noRow = await openFacts(stubDb([]).db, unwrap, WS, [fact]);
    const wrongKey = await openFacts(
      stubDb([{ actorId: "key:a", status: "active", encryptedKey: randomBytes(32) }]).db,
      unwrap,
      WS,
      [fact]
    );
    for (const [f] of [noUnwrapper, noRow, wrongKey]) {
      expect(f).toMatchObject({ statement: "[unreadable]", redacted: "unreadable" });
    }
  });

  it("does not touch the database when nothing is encrypted", async () => {
    const { db, lookups } = stubDb([]);
    const items = [{ id: "1", actorId: "key:a", statement: "plain", subject: "acme" }];
    expect(await openFacts(db, unwrap, WS, items)).toBe(items);
    expect(lookups).not.toHaveBeenCalled();
  });
});
