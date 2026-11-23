/**
 * APP-073 edge (re-audit 2026-11-22): an actor already has a DEK, but this
 * server runs without MNEMO_MASTER_KEY (no unwrapper). The refusal was a plain
 * Error, so the HTTP layer answered 500 instead of the coded 422 that the
 * no-DEK-yet case already gets.
 */
import { describe, expect, it, vi } from "vitest";
import { FactRepository } from "../../repositories/FactRepository.js";

const WS = "11111111-1111-1111-1111-111111111111";

/** A tx whose DEK lookup finds an active wrapped key. */
function txWithDek() {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: async () => [{ encryptedKey: Buffer.from("wrapped") }],
  };
  return { select: vi.fn(() => chain), execute: vi.fn() };
}

describe("FactRepository without an unwrapper (MNEMO_MASTER_KEY unset)", () => {
  const repo = new FactRepository({} as never, {} as never) as unknown as {
    sealForWrite(tx: unknown, input: Record<string, unknown>): Promise<unknown>;
    rowActorDek(tx: unknown, ws: string, actorId: string | null, what: string): Promise<unknown>;
  };

  it("a confidential write for an actor that has a DEK is refused with code encryption_not_configured", async () => {
    const err = await repo
      .sealForWrite(txWithDek(), {
        workspaceId: WS,
        actorId: "key:a-1",
        sensitivity: "confidential",
        statement: "s",
        subject: "x",
      })
      .catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("encryption_not_configured");
  });

  it("rewriting a confidential row is refused with the same code", async () => {
    const err = await repo.rowActorDek(txWithDek(), WS, "key:a-1", "updateFact").catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("encryption_not_configured");
  });
});
