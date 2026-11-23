"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import {
  AuthScene,
  AuthSubmit,
  authAlert,
  authInput,
  authLabel,
  authLabelFirst,
} from "@/components/auth-scene";
import { CopyFailed, useCopy } from "@/components/form-bits";
import { useT } from "@/lib/i18n/client";
import { errorMessage } from "@/lib/i18n/errors";
import { loadSignal } from "@/lib/load";

/**
 * First-run setup — creates the first workspace + API key via POST /bootstrap
 * (proxied as /dashboard/bootstrap). The person types the setup token (and,
 * optionally, an administrator account); the workspace id and the key are
 * generated here, never typed or edited (5.2). The key is shown exactly once. Spec §2.4.
 */

const KEY_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

function generateApiKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let secret = "";
  for (const b of bytes) secret += KEY_ALPHABET[b % KEY_ALPHABET.length];
  return `mns_live_${secret}`;
}

export default function SetupPage() {
  const t = useT();
  const router = useRouter();
  const [setupToken, setSetupToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [adminEmail, setAdminEmail] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const { copied, failed: copyFailed, copy } = useCopy();

  useEffect(() => {
    // If already bootstrapped, this page must not be reachable.
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/dashboard/bootstrap/status", { signal: loadSignal() });
        if (!cancelled && res.ok) {
          const { bootstrapped } = (await res.json()) as { bootstrapped: boolean };
          if (bootstrapped) router.replace("/login");
        }
      } catch {
        // Leave the form; submit will surface connectivity errors.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (Boolean(adminEmail.trim()) !== Boolean(adminPassword)) {
      setError(t("auth.adminBoth"));
      return;
    }
    setBusy(true);
    const apiKey = generateApiKey();
    try {
      const res = await fetch("/dashboard/bootstrap", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          setupToken: setupToken.trim(),
          workspaceId: crypto.randomUUID(),
          apiKey,
          label: "dashboard bootstrap",
          ...(adminEmail.trim() ? { adminEmail: adminEmail.trim(), adminPassword } : {}),
        }),
      });
      if (res.status === 201) {
        setCreatedKey(apiKey);
        return;
      }
      if (res.status === 403) {
        router.replace("/login");
        return;
      }
      if (res.status === 401) {
        setError(t("auth.setupTokenInvalid"));
        return;
      }
      const body = (await res.json().catch(() => null)) as { message?: string } | null;
      setError(body?.message ?? errorMessage(t, { status: res.status }));
    } catch {
      setError(errorMessage(t, { code: "network" }));
    } finally {
      setBusy(false);
    }
  }

  // Show-once screen after a successful bootstrap.
  if (createdKey) {
    return (
      <AuthScene
        image="medallion-rays"
        eyebrow={t("auth.eyebrowSetup")}
        title={t("auth.workspaceCreated")}
        lede={t("auth.keyShownOnce")}
      >
        <div className="flex items-center gap-2 border border-border bg-surface px-3 py-2">
          <code className="flex-1 break-all font-mono text-mono">{createdKey}</code>
          <button
            type="button"
            onClick={() => copy(createdKey)}
            className="shrink-0 border border-control-border px-2 py-1 text-ui-xs text-text-muted hover:border-accent hover:text-accent focus-visible:outline-2 focus-visible:outline-accent"
          >
            {copied ? t("auth.copied") : t("auth.copy")}
          </button>
        </div>
        <CopyFailed show={copyFailed} />
        <button type="button" onClick={() => router.replace("/login")} className="auth-btn mt-6">
          <span>{t("auth.continueToLogin")}</span>
          <kbd aria-hidden="true" className="font-mono text-mono-sm opacity-70">
            ↵
          </kbd>
        </button>
      </AuthScene>
    );
  }

  return (
    <AuthScene
      image="medallion-rays"
      eyebrow={t("auth.eyebrowSetup")}
      title={t("auth.setupTitle")}
      lede={t("auth.setupLede")}
    >
      <form onSubmit={onSubmit}>
        <label htmlFor="setupToken" className={authLabelFirst}>
          {t("auth.setupToken")}
        </label>
        <input
          id="setupToken"
          type="text"
          required
          autoComplete="off"
          spellCheck={false}
          value={setupToken}
          onChange={(e) => setSetupToken(e.target.value)}
          className={`${authInput} font-mono text-mono`}
        />
        <p className="mt-1 text-ui-xs text-text-muted">{t("auth.setupTokenNote")}</p>

        <p className="eyebrow mt-6">{t("auth.administrator")}</p>
        <p className="mt-1 text-ui-xs text-text-muted">{t("auth.administratorNote")}</p>
        <label htmlFor="adminEmail" className={authLabel}>
          {t("auth.administratorEmail")}
        </label>
        <input
          id="adminEmail"
          type="email"
          autoComplete="off"
          value={adminEmail}
          onChange={(e) => setAdminEmail(e.target.value)}
          className={authInput}
        />
        <label htmlFor="adminPassword" className={authLabel}>
          {t("auth.password")}
        </label>
        <input
          id="adminPassword"
          type="password"
          autoComplete="new-password"
          value={adminPassword}
          onChange={(e) => setAdminPassword(e.target.value)}
          className={authInput}
        />
        <p className="mt-1 text-ui-xs text-text-muted">{t("auth.minPassword")}</p>

        {error && (
          <p role="alert" className={authAlert}>
            {error}
          </p>
        )}

        <AuthSubmit disabled={busy}>
          {busy ? t("auth.creating") : t("auth.createWorkspace")}
        </AuthSubmit>
      </form>
    </AuthScene>
  );
}
