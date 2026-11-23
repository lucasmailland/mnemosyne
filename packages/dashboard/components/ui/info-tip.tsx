"use client";

import { useId, useRef, type ReactNode } from "react";

import { useT } from "@/lib/i18n/client";

import { usePopover } from "./popover";

/**
 * A definition or a help text behind an (i) button. Hovering shows it and leaving hides it; a click
 * (or Enter, Space, a tap) pins it open until Escape or a click elsewhere. The text is the button's
 * accessible description either way, so a screen reader hears it on focus. `textId` lets a form
 * control point its own aria-describedby at the same text.
 */
export function InfoTip({
  label,
  text,
  textId,
  className = "",
}: {
  /** What it is about: the button reads "About: {label}". */
  label: string;
  text: ReactNode;
  textId?: string;
  className?: string;
}) {
  const t = useT();
  const own = useId();
  const id = textId ?? own;
  const { open, panel, buttonProps, panelProps } = usePopover();
  // Opened by the pointer resting on it, not by a click: leaving closes it, a click pins it.
  const hovered = useRef(false);
  const show = () => {
    stay();
    if (open || !panel.current?.showPopover) return;
    hovered.current = true;
    panel.current.showPopover();
  };
  // Leaving waits a beat, so the pointer can move onto the text (WCAG 1.4.13: hoverable).
  const leaving = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stay = () => {
    if (leaving.current) clearTimeout(leaving.current);
    leaving.current = null;
  };
  const hide = () => {
    stay();
    leaving.current = setTimeout(() => {
      if (!hovered.current) return;
      hovered.current = false;
      panel.current?.hidePopover?.();
    }, 150);
  };
  return (
    <>
      <button
        {...buttonProps}
        aria-label={t("ui.about", { label })}
        aria-describedby={id}
        onMouseEnter={show}
        onMouseLeave={hide}
        onClick={(e) => {
          if (!hovered.current) return;
          // The hover opened it: the click keeps it open instead of toggling it shut.
          hovered.current = false;
          e.preventDefault();
        }}
        className={`info-tip text-text-faint hover:text-text focus-visible:outline-accent inline-flex size-6 shrink-0 items-center justify-center focus-visible:outline-2 ${className}`}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <rect
            x="1.5"
            y="1.5"
            width="11"
            height="11"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.25"
          />
          <rect x="6.25" y="3.5" width="1.5" height="1.5" fill="currentColor" />
          <rect x="6.25" y="6" width="1.5" height="4.5" fill="currentColor" />
        </svg>
      </button>
      {/* A span, so it can sit inside a paragraph or a label. */}
      <span
        {...panelProps}
        onMouseEnter={stay}
        onMouseLeave={hide}
        className="pop text-ui-xs px-3 py-2 leading-snug font-normal tracking-normal normal-case"
      >
        <span id={id}>{text}</span>
      </span>
    </>
  );
}
