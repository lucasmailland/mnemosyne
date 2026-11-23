"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { SPEC_SCOPES } from "@mnemo-ai/types";

import {
  Alert,
  CopyFailed,
  ghostButton,
  inputClass,
  inputShort,
  primaryButton,
  useCopy,
} from "@/components/form-bits";
import { Checkbox, ConfirmDialog, Field, useFocusSectionAfter } from "@/components/keeper";
import { RowMenu } from "@/components/ui/row-menu";
import { PALETTE_NAVIGATE } from "@/components/palette/palette-trigger";
import { useLocale, useT } from "@/lib/i18n/client";
import { formatDate } from "@/lib/i18n/core";

/** Create-key dialog with show-once result, and rotate/revoke per key (spec §4.7). */

// DASH-2: this used to be a hand-maintained 8-scope list that drifted from
// the real 15-scope contract (SPEC_SCOPES, @mnemo-ai/types) — missing
// memory:hard_delete, memory:task, memory:event, memory:self_edit,
// memory:procedural, memory:reasoning, memory:federation, memory:subscribe,
// and it included "admin:keys", which isn't a SPEC_SCOPES-tier (tenant-
// grantable) scope at all — it's a platform-tier scope from the broader
// ALL_SCOPES set (see security.ts and SEC-1's admin:workspace finding),
// never meant to be self-service mintable from this form.
//
// memory:hard_delete is deliberately excluded from the checkbox list too:
// it permanently, irrecoverably destroys data (bypasses the bitemporal
// forget() soft-close entirely) — handing it out via an easy-to-miss
// checkbox in a general-purpose key form is the kind of UI affordance that
// leads to an accidental grant. An operator who genuinely needs it can
// still request it out-of-band (CLI / direct API).
const ALL_SCOPES = SPEC_SCOPES.filter((s) => s !== "memory:hard_delete");

/** The palette's "New API key" (lib/palette-items.ts). */
const CREATE_HREF = "/admin/keys?create=1";

export function CreateKeyForm({ defaultOpen = false }: { defaultOpen?: boolean }) {
  const t = useT();
  const router = useRouter();
  const [open, setOpen] = useState(defaultOpen);
  // Opened by ?create=1 or by the palette: Label takes focus once the form is drawn.
  const [focusLabel, setFocusLabel] = useState(defaultOpen);
  const labelInput = useRef<HTMLInputElement>(null);
  const [label, setLabel] = useState("");
  const [scopes, setScopes] = useState<string[]>(["memory:read", "memory:write"]);
  const [expiresIn, setExpiresIn] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ key: string; label: string } | null>(null);
  const { copied, failed: copyFailed, copy } = useCopy();

  // "New API key" picked while this page is open: the address may not change (?create=1 again
  // after Cancel), so the pick itself opens the form. A show-once key on screen stays until Done.
  useEffect(() => {
    const onPick = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== CREATE_HREF) return;
      setOpen(true);
      setFocusLabel(true);
    };
    window.addEventListener(PALETTE_NAVIGATE, onPick);
    return () => window.removeEventListener(PALETTE_NAVIGATE, onPick);
  }, []);
  useEffect(() => {
    if (!open || !focusLabel || !labelInput.current) return;
    labelInput.current.focus();
    setFocusLabel(false);
  }, [open, focusLabel]);

  function toggleScope(s: string) {
    setScopes((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const body: Record<string, unknown> = { label, scopes };
      if (expiresIn) body.expiresIn = expiresIn;
      const res = await fetch("/dashboard/api/admin/keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => ({}))) as {
        key?: string;
        label?: string;
        error?: { message?: string } | string;
      };
      if (res.ok && json.key) {
        setCreated({ key: json.key, label: json.label ?? label });
        setOpen(false);
        setLabel("");
        router.refresh();
      } else {
        const msg =
          typeof json.error === "string"
            ? json.error
            : (json.error?.message ?? t("errors.httpStatus", { status: res.status }));
        setError(msg);
      }
    } catch {
      setError(t("errors.network"));
    } finally {
      setBusy(false);
    }
  }

  if (created) {
    return (
      <div className="border border-green/40 bg-surface p-4">
        <div className="text-ui font-medium text-green">
          {t("keys.createdTitle", { label: created.label })}
        </div>
        <p className="mt-2 text-ui-xs text-text-muted">{t("keys.shownOnce")}</p>
        <div className="mt-4 flex items-center gap-2 border border-border bg-surface-2 px-3 py-2">
          <code className="flex-1 break-all font-mono text-mono">{created.key}</code>
          <button
            type="button"
            onClick={() => copy(created.key)}
            className={`${ghostButton} shrink-0`}
          >
            {copied ? t("keys.copiedCheck") : t("common.copy")}
          </button>
        </div>
        <CopyFailed show={copyFailed} />
        <button type="button" onClick={() => setCreated(null)} className={`${ghostButton} mt-4`}>
          {t("common.done")}
        </button>
      </div>
    );
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className={primaryButton}>
        {t("keys.createKey")}
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4 border border-border bg-surface p-4">
      <Field label={t("keys.label")}>
        <input
          ref={labelInput}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          required
          maxLength={80}
          className={inputClass}
          placeholder={t("keys.labelPlaceholder")}
        />
      </Field>

      <fieldset>
        <legend className="text-ui font-medium text-text">{t("keys.scopes")}</legend>
        <div className="mt-2 grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
          {ALL_SCOPES.map((s) => (
            <Checkbox
              key={s}
              label={s}
              className="font-mono text-mono"
              checked={scopes.includes(s)}
              onChange={() => toggleScope(s)}
            />
          ))}
        </div>
      </fieldset>

      <Field label={t("keys.expiresOptional")}>
        <select
          value={expiresIn}
          onChange={(e) => setExpiresIn(e.target.value)}
          className={inputShort}
        >
          <option value="">{t("keys.never")}</option>
          <option value="30d">{t("keys.days30")}</option>
          <option value="90d">{t("keys.days90")}</option>
          <option value="365d">{t("keys.year1")}</option>
        </select>
      </Field>

      <Alert message={error} />

      <div className="flex flex-wrap gap-3">
        <button type="submit" disabled={busy || scopes.length === 0} className={primaryButton}>
          {busy ? t("keys.creating") : t("keys.create")}
        </button>
        <button type="button" onClick={() => setOpen(false)} className={ghostButton}>
          {t("common.cancel")}
        </button>
      </div>
    </form>
  );
}

/**
 * Rotate and Revoke for one key. Rotating mints a successor with the same
 * label and scopes and shows it once; the old key keeps working until the end
 * of the grace period, so clients can be switched over before it stops.
 */
export function KeyActions({
  keyId,
  label,
  rotated,
  children,
}: {
  keyId: string;
  label: string;
  /** Already rotated: it can only be revoked (the server refuses a second rotation). */
  rotated: boolean;
  /** The row's content, beside the "⋯" menu. */
  children?: React.ReactNode;
}) {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const [busy, setBusy] = useState<"rotate" | "revoke" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [minted, setMinted] = useState<{ key: string; sunsetAt: string } | null>(null);
  const { copied, failed: copyFailed, copy } = useCopy();
  const [confirming, setConfirming] = useState<"rotate" | "revoke" | null>(null);
  // Rotate and Revoke both take their own button away. Revoke sends focus to the list's heading;
  // a rotate sends it to the show-once new key, which is what the reader needs next.
  const focus = useFocusSectionAfter<HTMLDivElement>(confirming !== null);
  const mintedBox = useRef<HTMLElement>(null);
  const focusMinted = useRef(false);
  useEffect(() => {
    if (!minted || confirming !== null || !focusMinted.current) return;
    focusMinted.current = false;
    mintedBox.current?.focus();
  }, [minted, confirming]);
  const path = `/dashboard/api/admin/keys/${encodeURIComponent(keyId)}`;

  async function rotate() {
    setError(null);
    setBusy("rotate");
    try {
      const res = await fetch(`${path}/rotate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const json = (await res.json().catch(() => ({}))) as {
        newKey?: string;
        oldKeySunsetAt?: string;
        message?: string;
        error?: { message?: string } | string;
      };
      if (res.ok && json.newKey) {
        setMinted({ key: json.newKey, sunsetAt: json.oldKeySunsetAt ?? "" });
        focusMinted.current = true;
        router.refresh();
      } else {
        setError(
          json.message ??
            (typeof json.error === "string" ? json.error : json.error?.message) ??
            t("errors.httpStatus", { status: res.status })
        );
      }
    } catch {
      setError(t("errors.network"));
    } finally {
      setBusy(null);
      setConfirming(null);
    }
  }

  async function revoke() {
    setError(null);
    setBusy("revoke");
    try {
      const res = await fetch(path, { method: "DELETE" });
      if (!res.ok) setError(t("keys.revokeFailed", { status: res.status }));
      else focus.moved();
      router.refresh();
    } catch {
      setError(t("errors.network"));
    } finally {
      setBusy(null);
      setConfirming(null);
    }
  }

  return (
    <div ref={focus.ref} className="w-full">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">{children}</div>
        <RowMenu
          name={label}
          actions={[
            ...(rotated
              ? []
              : [
                  {
                    label: busy === "rotate" ? t("keys.rotating") : t("keys.rotate"),
                    ariaLabel: t("keys.rotateAria", { label }),
                    disabled: busy !== null,
                    onSelect: () => setConfirming("rotate"),
                  },
                ]),
            {
              label: busy === "revoke" ? t("keys.revoking") : t("keys.revoke"),
              ariaLabel: t("keys.revokeAria", { label }),
              danger: true,
              disabled: busy !== null,
              onSelect: () => setConfirming("revoke"),
            },
          ]}
        />
      </div>

      {!rotated && (
        <ConfirmDialog
          open={confirming === "rotate"}
          title={t("keys.rotateAria", { label })}
          body={t("keys.confirmRotate", { label })}
          confirmLabel={t("keys.rotate")}
          busy={busy !== null}
          onConfirm={rotate}
          onClose={() => setConfirming(null)}
        />
      )}
      <ConfirmDialog
        open={confirming === "revoke"}
        title={t("keys.revokeAria", { label })}
        body={t("keys.confirmRevoke", { label })}
        confirmLabel={t("keys.revoke")}
        tone="danger"
        busy={busy !== null}
        onConfirm={revoke}
        onClose={() => setConfirming(null)}
      />

      <Alert message={error} />

      {minted && (
        <section
          ref={mintedBox}
          tabIndex={-1}
          aria-label={t("keys.newKeyFor", { label })}
          className="mt-4 border border-green/40 bg-surface-2 p-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <div className="text-ui font-medium text-green">{t("keys.newKeyTitle", { label })}</div>
          <p className="mt-2 text-ui-xs text-text-muted">
            {t("keys.newKeyNote", {
              time: minted.sunsetAt
                ? formatDate(locale, minted.sunsetAt, "datetime")
                : t("keys.graceEnds"),
            })}
          </p>
          <div className="mt-4 flex items-center gap-2 border border-border bg-surface px-3 py-2">
            <code className="flex-1 break-all font-mono text-mono">{minted.key}</code>
            <button
              type="button"
              onClick={() => copy(minted.key)}
              className={`${ghostButton} shrink-0`}
            >
              {copied ? t("keys.copiedCheck") : t("common.copy")}
            </button>
          </div>
          <CopyFailed show={copyFailed} />
          <button type="button" onClick={() => setMinted(null)} className={`${ghostButton} mt-4`}>
            {t("common.done")}
          </button>
        </section>
      )}
    </div>
  );
}
