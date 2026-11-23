"use client";

import { useEffect, useState } from "react";

import { useT } from "@/lib/i18n/client";

export const OPEN_PALETTE = "mnemo:open-palette";
/**
 * The palette is about to navigate (a CustomEvent whose detail is the address): the phone drawer
 * closes even when only the search or hash changes, and a page already open at the address can
 * act on it (the keys page opens its form again for "New API key").
 */
export const PALETTE_NAVIGATE = "mnemo:palette-navigate";

/** Apple platforms take ⌘ for the shortcuts, the rest Ctrl (no platform reported reads as Apple). */
export function isApple(): boolean {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform || nav.platform || "";
  return !platform || /mac|iphone|ipad/i.test(platform);
}

/** "⌘" on Apple platforms, "Ctrl" elsewhere (after mount, so the server markup matches). */
export function useModKey(): "⌘" | "Ctrl" {
  const [mod, setMod] = useState<"⌘" | "Ctrl">("⌘");
  useEffect(() => {
    if (!isApple()) setMod("Ctrl");
  }, []);
  return mod;
}

/**
 * The sidebar's "Search the archive…" bar: opens the palette. `returnTo` names where focus
 * goes when the palette closes (the phone drawer hands over its Menu button, since the drawer
 * itself may be gone by then); otherwise the bar itself.
 */
export function PaletteTrigger({ returnTo }: { returnTo?: () => HTMLElement | null }) {
  const t = useT();
  const mod = useModKey();
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      // Passed along because Safari does not focus a button on click.
      onClick={(event) =>
        window.dispatchEvent(
          new CustomEvent(OPEN_PALETTE, { detail: returnTo?.() ?? event.currentTarget })
        )
      }
      className="mx-3 mt-3 flex min-h-11 items-center justify-between gap-2 border border-border bg-surface px-3 text-ui-sm text-text-muted hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
    >
      <span className="min-w-0 truncate">{t("palette.trigger")}</span>
      <kbd className="font-mono text-mono-xs text-text-faint">{mod === "⌘" ? "⌘K" : "Ctrl K"}</kbd>
    </button>
  );
}
