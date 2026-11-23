import type { MnemoFact } from "@mnemo-ai/types";

// CORE-2: validTo is widened to `Date | null | undefined` here (rather than
// reusing Pick<MnemoFact, "validTo">'s `Date | undefined`) because callers
// like isRecallableFact below pass rows straight from raw DB reads, where
// validTo is genuinely nullable (see the bitemporal model doc — validTo=NULL
// means "currently valid"). `== null` already catches both null and
// undefined, so this is a signal-preserving widening, not a behavior change.
export function isActiveOpenFact(
  fact: Pick<MnemoFact, "status"> & { validTo?: Date | null }
): boolean {
  return fact.status === "active" && fact.validTo == null;
}

/** includeArchived exposes soft-forgotten facts, never consolidation-merged facts. */
export function isRecallableFact(
  fact: { status: MnemoFact["status"]; validTo?: Date | null },
  includeArchived = false
): boolean {
  return (
    isActiveOpenFact(fact) ||
    (includeArchived && fact.status === "forgotten" && fact.validTo != null)
  );
}
