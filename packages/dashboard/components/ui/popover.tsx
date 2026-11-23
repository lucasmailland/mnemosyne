"use client";

import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";

/** The elements arrow keys move between inside a panel. */
const ITEM = "[data-item]:not(:disabled)";
/** Where focus lands when a panel opens, in order of preference. */
const FIRST = ["[data-autofocus]", `${ITEM}:checked`, `${ITEM}[aria-checked="true"]`, ITEM];

const visible = (el: HTMLElement) => !el.closest("[hidden]");

/**
 * A button and its panel on the native Popover API (popover="auto" + popovertarget): the browser
 * puts the panel in the top layer, closes it on Escape or a click outside, and works before the
 * page hydrates. `.pop` in globals.css anchors it under the button. This hook adds what the
 * platform leaves out: aria-expanded, focus on the panel's first control when it opens, focus back
 * on the button when it closes from inside, and arrow keys (Home, End) between `[data-item]`
 * elements. In a `menu` panel Tab closes it, as in any menu.
 */
export function usePopover({ menu = false }: { menu?: boolean } = {}) {
  const id = useId();
  const anchor = `--pop${id.replace(/[^\w-]/g, "")}`;
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  // Focus went inside the panel while it was open (so closing it may hand focus back).
  const inside = useRef(false);

  useEffect(() => {
    const el = panel.current;
    if (!el) return;
    const onToggle = (event: Event) => {
      const now = (event as Event & { newState?: string }).newState === "open";
      setOpen(now);
      if (now) {
        inside.current = false;
        for (const selector of FIRST) {
          const target = [...el.querySelectorAll<HTMLElement>(selector)].find(visible);
          if (target) return target.focus();
        }
      } else {
        // Escape or a pick inside: the browser may leave focus on the body (Safari), so the button
        // takes it back. A click elsewhere keeps the focus it moved there.
        const at = document.activeElement;
        if (el.contains(at) || (inside.current && (!at || at === document.body)))
          button.current?.focus();
      }
    };
    el.addEventListener("toggle", onToggle);
    return () => el.removeEventListener("toggle", onToggle);
  }, []);

  /** Close it and give focus back to the button, before an action that opens a dialog. */
  const close = () => {
    const el = panel.current;
    if (el?.hasAttribute("popover")) {
      try {
        el.hidePopover();
      } catch {
        // Already closed.
      }
    }
    button.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (menu && event.key === "Tab") return close();
    const keys = ["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"];
    if (!keys.includes(event.key)) return;
    const target = event.target as HTMLElement;
    // Arrows inside a text field move the caret, except down from it into the list.
    if (target.matches("input[type=search], input[type=text], input[type=date]")) {
      if (event.key !== "ArrowDown") return;
    } else if (!target.matches(ITEM)) return;
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>(ITEM)].filter(visible);
    if (items.length === 0) return;
    // Radios would also check on an arrow (and submit a filter): here arrows only move focus.
    event.preventDefault();
    const at = items.indexOf(target);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : event.key === "ArrowDown" || event.key === "ArrowRight"
            ? Math.min(at + 1, items.length - 1)
            : Math.max(at - 1, 0);
    items[next]?.focus();
  };

  return {
    open,
    close,
    panel,
    button,
    buttonProps: {
      ref: button,
      type: "button" as const,
      popoverTarget: id,
      "aria-expanded": open,
      "aria-controls": id,
      style: { anchorName: anchor } as CSSProperties,
    },
    panelProps: {
      // A callback, so the panel can be any element (a div, or a span inside a paragraph).
      ref: (el: HTMLElement | null) => {
        panel.current = el;
      },
      id,
      popover: "auto" as const,
      onKeyDown,
      onFocus: () => {
        inside.current = true;
      },
      style: { positionAnchor: anchor } as CSSProperties,
    },
  };
}

/** The chevron of a button that opens a panel. */
export function Chevron() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" className="shrink-0">
      <path d="M1.5 3.5 5 7l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

/** The quiet bordered button that opens a filter or a menu (40 px, square). */
export const popButton =
  "inline-flex min-h-10 items-center gap-2 border bg-surface px-3 text-ui-sm whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
