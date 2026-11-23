// Deterministic, dependency-free text-delta codec for DELTAMEM §16 residual
// episode trees (MEMORY_IMPROVEMENT.md:1296-1329).
//
// A child episode that overlaps its parent stores only the RESIDUAL between the
// parent's reconstructed narrative and its own. Encoding is line-based: we strip
// the longest common prefix and longest common suffix of lines, and persist only
// the differing middle window plus the two anchor counts. Reconstruction splices
// the residual middle back between the parent's prefix and suffix lines.
//
// This module is intentionally free of any runtime dependency so it can live in
// @mnemo-ai/types — the lowest package depended on by core, adapter-postgres,
// and the in-memory test adapter. It performs no I/O and is fully deterministic.

/** Magic header marking a residual (prefix/suffix-anchored) payload. */
export const DELTA_MAGIC_V1 = "MNEMO_DELTA_V1";
/** Magic header marking a full-text payload (used when a residual would not be smaller). */
export const FULL_MAGIC_V1 = "MNEMO_FULL_V1";

// Split into lines WITHOUT discarding information: we keep "\n" as the join glue
// and operate on the array. join("\n") of split("\n") is the identity on any
// string, so prefix/suffix splicing is exact (including blank and trailing lines).
function toLines(s: string): string[] {
  return s.split("\n");
}

/**
 * Encode `child` as a residual against `parent`.
 *
 * Format (residual, all parts newline-joined into ONE string):
 *   line 0: `MNEMO_DELTA_V1\t<prefixCount>\t<suffixCount>`
 *   line 1..N: the differing MIDDLE lines of `child`
 *
 * If the residual would not be strictly smaller than a full payload, returns a
 * full payload instead:
 *   line 0: `MNEMO_FULL_V1`
 *   line 1..N: the full `child` text
 *
 * `applyDelta` inverts whichever form is produced.
 */
export function encodeDelta(parent: string, child: string): string {
  const p = toLines(parent);
  const c = toLines(child);

  // Longest common prefix of lines.
  let prefix = 0;
  const maxPrefix = Math.min(p.length, c.length);
  while (prefix < maxPrefix && p[prefix] === c[prefix]) prefix++;

  // Longest common suffix of lines, not overlapping the matched prefix.
  let suffix = 0;
  const maxSuffix = Math.min(p.length, c.length) - prefix;
  while (
    suffix < maxSuffix &&
    p[p.length - 1 - suffix] === c[c.length - 1 - suffix]
  ) {
    suffix++;
  }

  const middle = c.slice(prefix, c.length - suffix);
  const header = `${DELTA_MAGIC_V1}\t${prefix}\t${suffix}`;
  const residual = [header, ...middle].join("\n");
  const full = `${FULL_MAGIC_V1}\n${child}`;

  // Prefer the residual only when it is strictly smaller; otherwise the full
  // payload guarantees correctness with no growth surprise for adversarial input.
  return residual.length < full.length ? residual : full;
}

/**
 * Reconstruct the child narrative from `parent` and an encoded `delta`.
 *
 * Back-compat: a `delta` that begins with neither magic header is treated as a
 * literal full narrative (legacy rows / raw fixtures written before WP5).
 */
export function applyDelta(parent: string, delta: string): string {
  if (delta.startsWith(`${FULL_MAGIC_V1}\n`)) {
    return delta.slice(FULL_MAGIC_V1.length + 1);
  }
  if (delta === FULL_MAGIC_V1) {
    return "";
  }
  if (!delta.startsWith(`${DELTA_MAGIC_V1}\t`)) {
    // Legacy: deltaContent already holds the full narrative.
    return delta;
  }

  const newlineIdx = delta.indexOf("\n");
  const headerLine = newlineIdx === -1 ? delta : delta.slice(0, newlineIdx);
  const body = newlineIdx === -1 ? "" : delta.slice(newlineIdx + 1);

  const parts = headerLine.split("\t");
  const prefix = Number(parts[1]);
  const suffix = Number(parts[2]);
  if (!Number.isInteger(prefix) || !Number.isInteger(suffix)) {
    throw new Error(`applyDelta: malformed ${DELTA_MAGIC_V1} header "${headerLine}"`);
  }

  const p = toLines(parent);
  // The header had no body line iff the middle window was empty (newlineIdx===-1).
  const middle = newlineIdx === -1 ? [] : toLines(body);

  const head = p.slice(0, prefix);
  const tail = suffix === 0 ? [] : p.slice(p.length - suffix);
  return [...head, ...middle, ...tail].join("\n");
}
