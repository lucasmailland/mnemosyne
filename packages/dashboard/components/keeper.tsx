"use client";

import { Dialog } from "@/components/dialog";
import { useT } from "@/lib/i18n/client";
import { cloneElement, isValidElement, useEffect, useId, useRef } from "react";
import type { InputHTMLAttributes, ReactNode } from "react";

import { dangerButton, ghostButton, primaryButton } from "./form-bits";
import { InfoTip } from "./ui/info-tip";

/** The keeper pages' shared pieces: sections, hairline records, quiet tags, fields, confirmations. */

/**
 * An eyebrow heading over a 1 px rule in the text color, with an optional action on the right.
 * The heading names the section (a region) and can take focus (see useFocusSectionAfter).
 */
export function Section({
  id,
  title,
  info,
  action,
  children,
}: {
  id?: string;
  title: string;
  /** What the section is about, behind an (i) beside the heading. */
  info?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section id={id} aria-labelledby={headingId} data-section className="mt-8">
      <div className="flex items-center justify-between gap-4 border-b border-text pb-2">
        <div className="flex items-center gap-1">
          <h2
            id={headingId}
            tabIndex={-1}
            className="eyebrow focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            {title}
          </h2>
          {info && <InfoTip label={title} text={info} />}
        </div>
        {action}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

/**
 * For a row whose confirmed action removes it or takes its button away (revoke, rotate,
 * remove): call `moved()` once the action worked, and when its dialog has closed focus goes to
 * the heading of the Section around `ref` instead of being lost with the row. The effect runs
 * after the Dialog's own (a parent's effects follow its children's), so it wins over the
 * Dialog handing focus back to a button that is about to go.
 */
export function useFocusSectionAfter<T extends HTMLElement>(dialogOpen: boolean) {
  const ref = useRef<T>(null);
  const pending = useRef(false);
  useEffect(() => {
    if (dialogOpen || !pending.current) return;
    pending.current = false;
    ref.current?.closest("[data-section]")?.querySelector<HTMLElement>("h2")?.focus();
  }, [dialogOpen]);
  return {
    ref,
    moved: () => {
      pending.current = true;
    },
  };
}

/** Hairline rows in a panel. */
export function Records({ label, children }: { label: string; children: ReactNode }) {
  return (
    <ul aria-label={label} className="divide-y divide-border border border-border bg-surface">
      {children}
    </ul>
  );
}

export function RecordRow({ children }: { children: ReactNode }) {
  return <li className="flex flex-wrap items-center gap-3 px-4 py-3">{children}</li>;
}

export type Tone = "neutral" | "good" | "warn" | "bad" | "accent";

const TONE_TEXT: Record<Tone, string> = {
  neutral: "text-text-muted",
  good: "text-green",
  warn: "text-yellow",
  bad: "text-red",
  accent: "text-accent",
};
const TONE_BORDER: Record<Tone, string> = {
  neutral: "border-border",
  good: "border-green",
  warn: "border-yellow",
  bad: "border-red",
  accent: "border-accent",
};
const TONE_DOT: Record<Tone, string> = {
  neutral: "bg-text-faint",
  good: "bg-green",
  warn: "bg-yellow",
  bad: "bg-red",
  accent: "bg-accent",
};

/** An outline tag: border and text in the tone, never a fill. */
export function StatusTag({
  tone = "neutral",
  caseless = false,
  children,
}: {
  tone?: Tone;
  /** Keeps the text as written (identifiers, sentences) instead of small caps. */
  caseless?: boolean;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex border px-2 py-1 ${
        caseless ? "text-ui-xs" : "text-eyebrow uppercase tracking-wider"
      } ${TONE_BORDER[tone]} ${TONE_TEXT[tone]}`}
    >
      {children}
    </span>
  );
}

/** A status dot with its label always visible (color is never the only signal). */
export function StatusDot({ tone = "neutral", label }: { tone?: Tone; label: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-ui">
      <span aria-hidden="true" className={`size-2 ${TONE_DOT[tone]}`} />
      {label}
    </span>
  );
}

/**
 * A label tied to its control by id, with an optional hint.
 *
 * In a Server Component page the children cross the RSC boundary and can reach this client
 * component as a lazy node, not yet an element: never read `children.props` without
 * `isValidElement`. Such pages pass `htmlFor` and the same `id` on the control, since only a
 * real element can be given a generated id (AUD-002).
 */
export function Field({
  label,
  htmlFor,
  hint,
  info,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  /** Help behind an (i) beside the label; still the control's description. */
  info?: string;
  children: ReactNode;
}) {
  const generated = useId();
  const hintId = useId();
  const infoId = useId();
  const described = [hint && hintId, info && infoId].filter(Boolean).join(" ");
  const element = isValidElement<{ id?: string; "aria-describedby"?: string }>(children)
    ? children
    : null;
  const id = htmlFor ?? element?.props.id ?? generated;
  const control = element
    ? cloneElement(element, {
        id,
        ...(described
          ? {
              "aria-describedby": [element.props["aria-describedby"], described]
                .filter(Boolean)
                .join(" "),
            }
          : {}),
      })
    : children;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1">
        <label htmlFor={id} className="text-ui font-medium text-text">
          {label}
        </label>
        {info && <InfoTip label={label} text={info} textId={infoId} />}
      </div>
      {control}
      {hint && (
        <p id={hintId} className="text-ui-xs text-text-muted">
          {hint}
        </p>
      )}
    </div>
  );
}

export function Checkbox({
  label,
  className = "",
  ...props
}: { label: string } & Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  return (
    <label className={`inline-flex min-h-6 items-center gap-2 text-ui text-text ${className}`}>
      <input
        type="checkbox"
        className="size-4 accent-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        {...props}
      />
      {label}
    </label>
  );
}

/** A confirmation on the shared Dialog. The danger tone focuses Cancel first. */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  tone,
  busy = false,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  tone?: "danger";
  /** While an async action runs: confirm and Cancel are disabled, Escape is ignored. */
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const cancel = useRef<HTMLButtonElement>(null);
  // Runs after the Dialog's own effect (parent effects follow children's), so it is already open.
  useEffect(() => {
    if (open && tone === "danger") cancel.current?.focus();
  }, [open, tone]);
  // While the action runs it cannot be called off: Cancel is disabled and Escape does nothing,
  // so the dialog never closes on an outcome that still lands.
  return (
    <Dialog open={open} title={title} onClose={busy ? () => {} : onClose}>
      <div className="text-ui text-text-muted">{body}</div>
      <div className="mt-5 flex justify-end gap-3">
        <button
          type="button"
          ref={cancel}
          onClick={onClose}
          disabled={busy}
          className={ghostButton}
        >
          {t("common.cancel")}
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy}
          aria-busy={busy || undefined}
          className={tone === "danger" ? dangerButton : primaryButton}
        >
          {confirmLabel}
        </button>
      </div>
    </Dialog>
  );
}
