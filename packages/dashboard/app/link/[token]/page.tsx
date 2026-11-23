"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import {
  AuthScene,
  AuthSubmit,
  authAlert,
  authInput,
  authLabel,
  authLabelFirst,
  authLinkButton,
} from "@/components/auth-scene";
import { useT } from "@/lib/i18n/client";
import { errorMessage } from "@/lib/i18n/errors";
import { loadSignal } from "@/lib/load";

/**
 * Public single-use link page (invitation, account setup, password reset).
 * The token in the URL is the credential: it is sent only to this origin's
 * /dashboard/auth/link/:token and never logged. The only other place it goes is
 * the login page's ?next= (same origin), when an existing account must sign in
 * before accepting. The page loads nothing from a third party (Referrer-Policy: no-referrer is set
 * for /dashboard/link/* in next.config.ts).
 */

type Purpose = "invite" | "account_setup" | "password_reset";

interface LinkInfo {
  purpose: Purpose;
  workspaceName: string | null;
  accountExists: boolean;
}

function LinkForm() {
  const t = useT();
  const router = useRouter();
  const { token } = useParams<{ token: string }>();
  const [info, setInfo] = useState<LinkInfo | "invalid" | "unavailable" | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const [busy, setBusy] = useState(false);
  const alertRef = useRef<HTMLParagraphElement>(null);
  const firstRef = useRef<HTMLInputElement>(null);
  const submitRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/dashboard/auth/link/${encodeURIComponent(token)}`, {
          cache: "no-store",
          referrerPolicy: "no-referrer",
          signal: loadSignal(),
        });
        if (cancelled) return;
        if (res.ok) setInfo((await res.json()) as LinkInfo);
        else setInfo(res.status === 404 ? "invalid" : "unavailable");
      } catch {
        if (!cancelled) setInfo("unavailable");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const ready = info !== null && typeof info === "object";
  const needsPassword = ready && (info.purpose === "password_reset" || !info.accountExists);

  useEffect(() => {
    if (error) alertRef.current?.focus();
  }, [error]);
  useEffect(() => {
    if (!ready) return;
    // First field of the form; with no field (accept as an existing account) the button.
    (firstRef.current ?? submitRef.current)?.focus();
  }, [ready]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setError(null);
    setNeedsSignIn(false);
    setBusy(true);
    try {
      const res = await fetch(`/dashboard/auth/link/${encodeURIComponent(token)}`, {
        method: "POST",
        referrerPolicy: "no-referrer",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          needsPassword
            ? {
                password,
                ...(info.accountExists || !displayName.trim()
                  ? {}
                  : { displayName: displayName.trim() }),
              }
            : {}
        ),
      });
      if (res.ok) {
        setPassword("");
        const body = (await res.json().catch(() => ({}))) as { workspaceId?: string | null };
        router.replace(body.workspaceId ? "/" : "/login");
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
      if (res.status === 404) setInfo("invalid");
      else if (res.status === 401) {
        setNeedsSignIn(true);
        setError(t("auth.signInWithInvited"));
      } else if (res.status === 400 && body.error === "password_policy")
        setError(body.message ?? t("auth.choosePassword"));
      else if (res.status === 400) setError(body.message ?? t("auth.checkDetails"));
      else setError(errorMessage(t, { status: res.status }));
    } catch {
      setError(errorMessage(t, { code: "network" }));
    } finally {
      setBusy(false);
    }
  }

  const scene = (title: string, children: React.ReactNode) => (
    <AuthScene image="wide-rays" eyebrow={t("auth.eyebrowLink")} title={title} lede="">
      {children}
    </AuthScene>
  );

  if (info === null)
    return scene(
      t("auth.linkChecking"),
      <p className="text-ui-sm text-text-muted" role="status">
        {t("auth.linkOneMoment")}
      </p>
    );
  if (info === "invalid")
    return scene(
      t("auth.linkInvalidTitle"),
      <>
        <p role="alert" className="text-ui">
          {t("auth.linkInvalid")}
        </p>
        <Link href="/login" className={authLinkButton}>
          {t("auth.linkGoToSignIn")}
        </Link>
      </>
    );
  if (info === "unavailable")
    return scene(
      t("auth.linkUnavailableTitle"),
      <p role="alert" className="text-ui">
        {t("auth.linkUnavailable")}
      </p>
    );

  const workspace = info.workspaceName ?? t("auth.yourWorkspace");
  const copy = {
    invite: {
      subtitle: info.accountExists
        ? t("auth.inviteExisting", { workspace })
        : t("auth.inviteNew", { workspace }),
      submit: t("auth.join", { workspace }),
      busy: t("auth.joining"),
    },
    account_setup: {
      subtitle: t("auth.accountSetup"),
      submit: t("auth.createAccount"),
      busy: t("auth.creatingAccount"),
    },
    password_reset: {
      subtitle: t("auth.passwordReset"),
      submit: t("auth.setNewPassword"),
      busy: t("auth.saving"),
    },
  }[info.purpose];

  return scene(
    copy.subtitle,
    <form onSubmit={onSubmit} aria-busy={busy}>
      {needsPassword ? (
        <>
          {!info.accountExists && (
            <>
              <label htmlFor="displayName" className={authLabelFirst}>
                {t("auth.displayName")}{" "}
                <span className="text-text-muted">{t("auth.optional")}</span>
              </label>
              <input
                ref={firstRef}
                id="displayName"
                autoComplete="name"
                maxLength={200}
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className={authInput}
                disabled={busy}
              />
            </>
          )}
          <label htmlFor="password" className={info.accountExists ? authLabelFirst : authLabel}>
            {info.purpose === "password_reset" ? t("auth.newPassword") : t("auth.password")}
          </label>
          <input
            ref={info.accountExists ? firstRef : undefined}
            id="password"
            type="password"
            autoComplete="new-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={authInput}
            disabled={busy}
          />
          <p className="mt-2 text-ui-xs text-text-muted">{t("auth.minPassword")}</p>
        </>
      ) : (
        <p className="text-ui-sm text-text-muted">{t("auth.existingAccount")}</p>
      )}
      {error && (
        <p ref={alertRef} tabIndex={-1} role="alert" aria-live="assertive" className={authAlert}>
          {error}
        </p>
      )}
      <AuthSubmit ref={submitRef} disabled={busy || (needsPassword && !password)}>
        {busy ? copy.busy : copy.submit}
      </AuthSubmit>
      {!needsPassword && (
        <Link
          href={`/login?next=${encodeURIComponent(`/dashboard/link/${token}`)}`}
          className={authLinkButton}
        >
          {needsSignIn ? t("auth.signInInvitedLink") : t("auth.signInFirst")}
        </Link>
      )}
    </form>
  );
}

export default function LinkPage() {
  return <LinkForm />;
}
