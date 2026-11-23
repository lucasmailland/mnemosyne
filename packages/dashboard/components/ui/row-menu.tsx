"use client";

import { useT } from "@/lib/i18n/client";

import { usePopover } from "./popover";

export interface RowAction {
  label: string;
  /** The full name for assistive technology ("Disable a@b.test"), when the label needs context. */
  ariaLabel?: string;
  onSelect: () => void;
  /** Destructive: drawn in red, after a separator, below the others. */
  danger?: boolean;
  disabled?: boolean;
}

/**
 * A row's actions behind one "⋯" button: a native popover menu with arrow keys, Home and End,
 * Escape and Tab to leave. Picking an item closes the menu and puts focus back on the button
 * before the action runs, so a ConfirmDialog it opens returns focus there too.
 */
export function RowMenu({ name, actions }: { name: string; actions: RowAction[] }) {
  const t = useT();
  const { buttonProps, panelProps, close } = usePopover({ menu: true });
  const safe = actions.filter((a) => !a.danger);
  const danger = actions.filter((a) => a.danger);
  const item = (a: RowAction) => (
    <button
      key={a.label}
      data-item
      type="button"
      role="menuitem"
      disabled={a.disabled}
      aria-label={a.ariaLabel}
      onClick={() => {
        close();
        a.onSelect();
      }}
      className={`hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-accent text-ui-sm flex min-h-10 w-full items-center px-3 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 disabled:opacity-50 ${
        a.danger ? "text-red" : "text-text"
      }`}
    >
      {a.label}
    </button>
  );
  return (
    <>
      <button
        {...buttonProps}
        aria-haspopup="menu"
        aria-label={t("ui.rowActions", { name })}
        className="border-control-border text-text-muted hover:border-accent hover:text-accent focus-visible:outline-accent inline-flex size-10 shrink-0 items-center justify-center border focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        <svg width="16" height="4" viewBox="0 0 16 4" aria-hidden="true">
          <rect x="0" y="0" width="4" height="4" fill="currentColor" />
          <rect x="6" y="0" width="4" height="4" fill="currentColor" />
          <rect x="12" y="0" width="4" height="4" fill="currentColor" />
        </svg>
      </button>
      <div
        {...panelProps}
        role="menu"
        aria-label={t("ui.rowActions", { name })}
        className="pop min-w-48 py-1"
      >
        {safe.map(item)}
        {safe.length > 0 && danger.length > 0 && (
          <div role="separator" className="border-border my-1 border-t" />
        )}
        {danger.map(item)}
      </div>
    </>
  );
}
