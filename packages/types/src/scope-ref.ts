/**
 * P135: the scope_ref values a read filter accepts — `scopeRef` plus the other
 * spellings of the same project (`scopeRefAliases`), deduplicated. `undefined`
 * when the filter names no scopeRef, so callers keep their "no condition" path.
 */
export function scopeRefValues(filter: {
  scopeRef?: string | undefined;
  scopeRefAliases?: string[] | undefined;
}): string[] | undefined {
  if (!filter.scopeRef) return undefined;
  return [...new Set([filter.scopeRef, ...(filter.scopeRefAliases ?? [])])];
}

/** True when `value` is one of the scope_ref values the filter accepts (or the filter names none). */
export function scopeRefMatches(
  value: string | null | undefined,
  filter: { scopeRef?: string | undefined; scopeRefAliases?: string[] | undefined }
): boolean {
  const accepted = scopeRefValues(filter);
  return accepted === undefined || (value != null && accepted.includes(value));
}
