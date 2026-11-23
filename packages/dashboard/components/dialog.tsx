"use client";

import { useEffect, useId, useRef } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A modal dialog on the native <dialog>: the browser traps focus inside it,
 * makes the rest of the page inert and closes it on Escape (reported through
 * `onClose`). Focus returns to whatever opened it. Keep the content mounted
 * only while `open`, so a form starts fresh each time.
 */
export function Dialog({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      opener.current = document.activeElement as HTMLElement | null;
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    } else if (!open && dialog.open) {
      if (typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
      const back = opener.current;
      opener.current = null;
      if (back?.isConnected) back.focus();
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-modal="true"
      onKeyDown={(event) => {
        // The browser lets Tab leave a modal dialog for its own chrome: wrap it.
        if (event.key !== "Tab") return;
        const focusable = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE)
        ).filter((el) => el.offsetParent !== null || el === document.activeElement);
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!first || !last) {
          event.preventDefault();
          return;
        }
        const active = document.activeElement;
        if (event.shiftKey && (active === first || active === event.currentTarget)) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && active === last) {
          event.preventDefault();
          first.focus();
        }
      }}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      // `modal`: the backdrop fades and the panel fades and scales in (globals.css).
      className="modal m-auto w-11/12 max-w-md border border-border bg-surface p-6 text-text backdrop:bg-black/60"
    >
      {open && (
        <>
          <h2 id={titleId} className="break-words text-ui-lg font-semibold">
            {title}
          </h2>
          <div className="mt-3">{children}</div>
        </>
      )}
    </dialog>
  );
}
