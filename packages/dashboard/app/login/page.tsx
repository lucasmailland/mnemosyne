"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useId, useRef, useState } from "react";
import {
  AuthScene,
  AuthSubmit,
  authAlert,
  authInput,
  authLabel,
  authLabelFirst,
  authLinkButton,
} from "@/components/auth-scene";
import { fieldError } from "@/components/form-bits";
import { useT } from "@/lib/i18n/client";
import { errorMessage } from "@/lib/i18n/errors";
import { loadSignal } from "@/lib/load";
import { roleLabel, type WorkspaceRole } from "@/lib/roles";
import { sanitizeDashboardNext } from "@/lib/utils";

function LoginForm() {
  const t = useT();
  const router = useRouter();
  const params = useSearchParams();
  const [apiKeyMode, setApiKeyMode] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [workspaces, setWorkspaces] = useState<Array<{
    id: string;
    name: string;
    role: WorkspaceRole;
  }> | null>(null);
  const [accountEmail, setAccountEmail] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** The credentials were refused: the fields are marked invalid (the message takes focus). */
  const [refused, setRefused] = useState(false);
  const alertId = useId();
  const [busy, setBusy] = useState(false);
  const [checkingBootstrap, setCheckingBootstrap] = useState(true);
  const selectRef = useRef<HTMLSelectElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const keyRef = useRef<HTMLInputElement>(null);
  const alertRef = useRef<HTMLParagraphElement>(null);

  // Any error takes focus (AUTH-02, as on the link page): role="alert" announces it, and the
  // keyboard lands on it; the refused fields point at it with aria-errormessage.
  useEffect(() => {
    if (error) alertRef.current?.focus();
  }, [error]);
  useEffect(() => {
    if (workspaces) selectRef.current?.focus();
  }, [workspaces]);
  useEffect(() => {
    if (apiKeyMode) keyRef.current?.focus();
    else emailRef.current?.focus();
  }, [apiKeyMode]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/dashboard/bootstrap/status", { signal: loadSignal() });
        if (!cancelled && res.ok && !(await res.json()).bootstrapped) {
          router.replace("/setup");
          return;
        }
      } catch {
        /* Login displays connection errors. */
      }
      if (!cancelled) setCheckingBootstrap(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setRefused(false);
    setBusy(true);
    try {
      const res = await fetch(`/dashboard/auth/${workspaces ? "workspace" : "login"}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          workspaces
            ? { workspaceId }
            : apiKeyMode
              ? { apiKey: apiKey.trim() }
              : { email: email.trim(), password }
        ),
      });
      if (res.ok) {
        // Older API-key servers may return an empty body.
        const body = await res.json().catch(() => ({}));
        setPassword("");
        setApiKey("");
        if (body.requiresWorkspace) {
          setAccountEmail(body.email ?? email.trim().toLowerCase());
          setWorkspaces(body.workspaces);
          setWorkspaceId(body.preferredWorkspaceId ?? body.workspaces[0]?.id ?? "");
          return;
        }
        const next = sanitizeDashboardNext(params.get("next"));
        router.replace(next.replace(/^\/dashboard/, "") || "/");
        return;
      }
      if (res.status === 401) {
        setRefused(!workspaces);
        setError(
          t(
            workspaces
              ? "auth.workspaceExpired"
              : apiKeyMode
                ? "auth.invalidApiKey"
                : "auth.invalidCredentials"
          )
        );
      } else setError(errorMessage(t, { status: res.status }));
    } catch {
      setError(errorMessage(t, { code: "network" }));
    } finally {
      setBusy(false);
    }
  }
  return (
    <AuthScene
      image="echo"
      eyebrow={t("auth.eyebrowLogin")}
      title={t("auth.loginTitle")}
      lede={t("auth.loginLede")}
    >
      <form onSubmit={onSubmit} aria-busy={busy || checkingBootstrap}>
        {workspaces ? (
          <>
            <p className="mb-4 break-words text-ui-sm text-text-muted">
              {t("auth.signedInAs")} <span className="font-medium text-text">{accountEmail}</span>
            </p>
            <label htmlFor="workspace" className={authLabelFirst}>
              {t("auth.workspace")}
            </label>
            <select
              ref={selectRef}
              id="workspace"
              className={authInput}
              value={workspaceId}
              onChange={(e) => {
                setWorkspaceId(e.target.value);
                setError(null);
              }}
              disabled={busy}
            >
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name} — {roleLabel(t, workspace.role)}
                  {workspaces.filter((item) => item.name === workspace.name).length > 1
                    ? ` (${workspace.id})`
                    : ""}
                </option>
              ))}
            </select>
            <p className="mt-3 text-ui-xs text-text-muted">{t("auth.chooseWorkspace")}</p>
          </>
        ) : apiKeyMode ? (
          <>
            <label htmlFor="apiKey" className={authLabelFirst}>
              {t("auth.apiKey")}
            </label>
            <input
              ref={keyRef}
              id="apiKey"
              type="password"
              autoComplete="off"
              required
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              {...fieldError(alertId, refused)}
              className={authInput}
              disabled={busy}
            />
            <p className="mt-3 text-ui-xs text-text-muted">{t("auth.apiKeyNote")}</p>
          </>
        ) : (
          <>
            <label htmlFor="email" className={authLabelFirst}>
              {t("auth.email")}
            </label>
            <input
              ref={emailRef}
              id="email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              {...fieldError(alertId, refused)}
              className={authInput}
              disabled={busy}
            />
            <label htmlFor="password" className={authLabel}>
              {t("auth.password")}
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              {...fieldError(alertId, refused)}
              className={authInput}
              disabled={busy}
            />
          </>
        )}
        {error && (
          <p ref={alertRef} id={alertId} tabIndex={-1} role="alert" className={authAlert}>
            {error}
          </p>
        )}
        <AuthSubmit
          disabled={
            busy ||
            checkingBootstrap ||
            (workspaces ? !workspaceId : apiKeyMode ? !apiKey.trim() : !email.trim() || !password)
          }
        >
          {busy
            ? workspaces
              ? t("auth.openingWorkspace")
              : t("auth.signingIn")
            : workspaces
              ? t("auth.continue")
              : t("auth.signIn")}
        </AuthSubmit>
        <button
          type="button"
          disabled={busy}
          className={authLinkButton}
          onClick={() => {
            setError(null);
            setPassword("");
            setApiKey("");
            if (workspaces) {
              setWorkspaces(null);
            } else setApiKeyMode(!apiKeyMode);
          }}
        >
          {workspaces
            ? t("auth.signInAgain")
            : apiKeyMode
              ? t("auth.signInWithEmail")
              : t("auth.signInWithApiKey")}
        </button>
      </form>
    </AuthScene>
  );
}
export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
