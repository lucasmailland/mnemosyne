"use client";
import { useEffect, useId, useRef, useState } from "react";

import { AuthSubmit } from "@/components/auth-scene";
import { Alert, fieldError, inputClass } from "@/components/form-bits";
import { Field } from "@/components/keeper";
import { useT } from "@/lib/i18n/client";

export function PasswordForm() {
  const t = useT();
  const [currentPassword, setCurrent] = useState("");
  const [newPassword, setNew] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The field the error is about, if any: it is marked invalid and takes focus. */
  const [errorField, setErrorField] = useState<"current" | "new" | null>(null);
  const [success, setSuccess] = useState(false);
  const alertId = useId();
  const currentRef = useRef<HTMLInputElement>(null);
  const newRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (errorField) (errorField === "current" ? currentRef : newRef).current?.focus();
  }, [errorField, error]);
  function clearFeedback() {
    setError(null);
    setErrorField(null);
    setSuccess(false);
  }
  function fail(message: string, field: "current" | "new" | null = null) {
    setError(message);
    setErrorField(field);
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    clearFeedback();
    if ([...newPassword].length < 12) {
      fail(t("account.tooShort"), "new");
      return;
    }
    if (new TextEncoder().encode(newPassword).length > 72) {
      fail(t("account.tooLong"), "new");
      return;
    }
    setBusy(true);
    try {
      const response = await fetch("/dashboard/auth/password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      if (response.ok) {
        setCurrent("");
        setNew("");
        setSuccess(true);
      } else if (response.status === 401) fail(t("account.verifyFailed"), "current");
      else if (response.status === 429) fail(t("errors.tooManyAttempts"));
      else if (response.status === 400) {
        const body = await response.json();
        fail(body.message ?? t("account.checkRequirements"), "new");
      } else fail(t("account.changeFailed"));
    } catch {
      fail(t("errors.network"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} noValidate aria-busy={busy} className="flex max-w-md flex-col gap-4">
      <Field label={t("account.currentPassword")} htmlFor="currentPassword">
        <input
          ref={currentRef}
          type="password"
          autoComplete="current-password"
          value={currentPassword}
          onChange={(e) => {
            setCurrent(e.target.value);
            clearFeedback();
          }}
          disabled={busy}
          required
          {...fieldError(alertId, errorField === "current")}
          className={inputClass}
        />
      </Field>
      <Field label={t("account.newPassword")} htmlFor="newPassword">
        <input
          ref={newRef}
          type="password"
          autoComplete="new-password"
          value={newPassword}
          onChange={(e) => {
            setNew(e.target.value);
            clearFeedback();
          }}
          disabled={busy}
          required
          aria-describedby="password-policy"
          {...fieldError(alertId, errorField === "new")}
          className={inputClass}
        />
      </Field>
      <p id="password-policy" className="text-ui-xs text-text-muted">
        {t("account.passwordPolicy")}
      </p>
      <Alert id={alertId} message={error} />
      {success && (
        <p role="status" aria-live="polite" className="text-ui text-green">
          {t("account.changed")}
        </p>
      )}
      <AuthSubmit className="mt-2" disabled={busy || !currentPassword || !newPassword}>
        {busy ? t("account.changing") : t("account.change")}
      </AuthSubmit>
    </form>
  );
}
