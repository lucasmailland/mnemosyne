"use client";

import { useLocale, useT } from "@/lib/i18n/client";
import { formatDate, type MessageKey, type T } from "@/lib/i18n/core";
import { useEffect, useId, useRef, useState } from "react";

/** Class strings and small pieces shared by the Members and Installation pages. */

const inputBase =
  "min-h-10 border border-control-border bg-surface-2 px-3 py-2 text-ui text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:bg-surface disabled:opacity-60";
export const inputClass = `w-full max-w-xl ${inputBase}`;
/** A fixed short field (a number, a short choice). */
export const inputShort = `w-32 ${inputBase}`;
export const selectClass = inputClass;
/** The ghost button without its hover color, so each variant names its own (no `!` overrides). */
const ghostBase =
  "inline-flex min-h-10 items-center justify-center border border-control-border px-3 py-2 text-ui-xs text-text-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50";
export const ghostButton = `${ghostBase} hover:border-accent hover:text-accent`;
export const dangerButton =
  "inline-flex min-h-10 items-center justify-center bg-red px-4 py-2 text-ui font-medium text-on-accent hover:brightness-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50";
export const dangerGhostButton = `${ghostBase} hover:border-red/50 hover:text-red`;
export const primaryButton =
  "inline-flex min-h-10 items-center justify-center bg-accent px-4 py-2 text-ui font-medium text-on-accent hover:bg-accent-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50";

/**
 * A form's error message. role="alert" is its one live region (APP-058), and it takes focus
 * when it appears so the keyboard lands where the error is (AUTH-02, the e2e specs). When the
 * error is about a field, give the Alert an `id` and the field `fieldError(id, …)`.
 */
export function Alert({ message, id }: { message: string | null; id?: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (message) ref.current?.focus();
  }, [message]);
  if (!message) return null;
  return (
    <p
      ref={ref}
      id={id}
      tabIndex={-1}
      role="alert"
      className="mt-3 w-full border border-border border-l-4 border-l-red px-3 py-2 text-ui text-red"
    >
      {message}
    </p>
  );
}

/**
 * Ties a field to the form's error message while the error is about it (APP-058): marked
 * invalid, with the message as its error. `on` false: nothing, so the field reads as valid.
 */
export function fieldError(alertId: string, on: boolean) {
  return on ? { "aria-invalid": true as const, "aria-errormessage": alertId } : {};
}

/**
 * Copy to the clipboard. `navigator.clipboard` is missing outside a secure context (the
 * dashboard over plain http) and the browser may refuse: then `failed` is set and the
 * caller tells the reader to copy by hand (`common.copyFailed`) or selects the text.
 */
export function useCopy() {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  async function copy(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      setFailed(true);
      return false;
    }
    setFailed(false);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    return true;
  }
  return { copied, failed, copy };
}

/** The "copy it by hand" line under a value whose Copy failed. */
export function CopyFailed({ show }: { show: boolean }) {
  const t = useT();
  if (!show) return null;
  return (
    <p role="alert" className="mt-2 text-ui-xs text-red">
      {t("common.copyFailed")}
    </p>
  );
}

export interface IssuedLinkData {
  /** The only person the link is meant for. */
  email: string;
  link: string;
  expiresAt: string;
}

/**
 * A link is shown once: read-only field, Copy, and who may receive it.
 * `label` names the link kind ("Invitation link for a@b.test").
 */
export function IssuedLink({
  label,
  issued,
  onDone,
  bare = false,
}: {
  label: string;
  issued: IssuedLinkData;
  onDone: () => void;
  /** Without its own frame, for use inside a dialog. */
  bare?: boolean;
}) {
  const t = useT();
  const locale = useLocale();
  const { copied, copy: copyText } = useCopy();
  const field = useRef<HTMLInputElement>(null);
  const fieldId = useId();
  useEffect(() => field.current?.focus(), []);
  async function copy() {
    // The link sits in a field: on failure select it, ready to copy by hand.
    if (!(await copyText(issued.link))) field.current?.select();
  }
  return (
    <div className={bare ? "" : "mt-4 border border-green/40 bg-surface p-4"}>
      <label htmlFor={fieldId} className="text-ui font-medium text-green">
        {label}
      </label>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input
          ref={field}
          id={fieldId}
          readOnly
          value={issued.link}
          onFocus={(e) => e.currentTarget.select()}
          className={`${inputClass} min-w-0 flex-1 font-mono text-ui-xs`}
        />
        <button type="button" onClick={copy} className={ghostButton}>
          {copied ? t("common.copied") : t("common.copy")}
        </button>
      </div>
      <p className="mt-2 text-ui-xs text-text-muted">
        {t("common.issuedLinkNote", {
          email: issued.email,
          date: formatDate(locale, issued.expiresAt, "short"),
        })}
      </p>
      <button type="button" onClick={onDone} className={`${ghostButton} mt-3`}>
        {t("common.done")}
      </button>
    </div>
  );
}

/** The message for a failed API answer, from a code table. Never includes a link. */
export async function failureMessage(
  t: T,
  res: Response,
  copy: Record<string, MessageKey>
): Promise<string> {
  if (res.status === 429) return t("errors.tooManyAttempts");
  const body = (await res.json().catch(() => ({}))) as { error?: unknown };
  const code = typeof body.error === "string" ? body.error : "";
  // The code comes from the server: own entries only, never Object's ("constructor").
  const key = Object.hasOwn(copy, code) ? copy[code] : undefined;
  return key ? t(key) : t("errors.httpStatus", { status: res.status });
}
