"use client";

import { useEffect } from "react";

/**
 * On stacked layouts the open detail sits below its list, so a tap that only changes `?open`
 * leaves it off-screen. Whenever `open` is set (on mount, for a link from another room, and on
 * every change) bring `targetId` into view and focus `headingId`. Without `below` the layout is
 * always stacked; with it, nothing happens at or above that width.
 */
export function ScrollIntoViewOnOpen({
  open,
  targetId,
  headingId,
  below,
}: {
  open: string | undefined;
  targetId: string;
  headingId: string;
  /** Stacked below this width in px (the page's own breakpoint); omit when always stacked. */
  below?: number;
}) {
  useEffect(() => {
    if (!open) return;
    const query = (q: string) => window.matchMedia?.(q)?.matches ?? false;
    if (below !== undefined && !query(`(max-width: ${below - 0.02}px)`)) return;
    const reduced = query("(prefers-reduced-motion: reduce)");
    document
      .getElementById(targetId)
      ?.scrollIntoView?.({ block: "start", behavior: reduced ? "auto" : "smooth" });
    document.getElementById(headingId)?.focus({ preventScroll: true });
  }, [open, targetId, headingId, below]);
  return null;
}
