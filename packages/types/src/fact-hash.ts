import { createHash } from "node:crypto";

/**
 * The content fingerprint behind `mnemo_fact_hash`.
 *
 * P126 — this lived inline in five places: three in `cognitive/remember.ts`
 * (the dedupe lookup and two upserts), one in `FactRepository`'s supersede
 * path, and a sixth was about to be added by the fix for the in-place-edit
 * case. Five copies of a hash formula is not a style problem: the fingerprint
 * only works if the writer and the reader agree BYTE FOR BYTE, and a drifted
 * copy does not error — it silently stops matching, and the dedupe it backs
 * quietly turns into a duplicate factory.
 *
 * The normalisation is deliberately shallow: trim and lowercase only. It is not
 * trying to decide that two differently-worded statements mean the same thing —
 * that is `remember()`'s surprise gate and the conflict machinery, both of
 * which reason about embeddings. This answers the narrower question "is this
 * the SAME TEXT, said again".
 *
 * `subject` participates because the same sentence under a different subject is
 * a different assertion, and the trailing `fact` keeps the space from colliding
 * with a future primitive's fingerprints.
 */
export function factStatementHash(statement: string, subject: string): string {
  const normalised = `${statement.trim().toLowerCase()}|${subject}|fact`;
  return createHash("sha256").update(normalised).digest("hex");
}
