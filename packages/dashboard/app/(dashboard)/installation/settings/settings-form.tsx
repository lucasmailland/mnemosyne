"use client";

import { useRef, useState } from "react";

import {
  Alert,
  failureMessage,
  inputClass,
  inputShort,
  primaryButton,
} from "@/components/form-bits";
import { Checkbox, Section } from "@/components/keeper";
import { InfoTip } from "@/components/ui/info-tip";
import { useT } from "@/lib/i18n/client";
import type { MessageKey } from "@/lib/i18n/core";

type Source = "global" | "env" | "default";

export interface SettingsView {
  invitationsEnabled: boolean;
  publicBaseUrl: string | null;
  registrationMode: "closed";
  workspaceLlmOverride: boolean;
  workspaceLimitPerUser: number;
  source: Record<
    | "invitationsEnabled"
    | "publicBaseUrl"
    | "registrationMode"
    | "workspaceLlmOverride"
    | "workspaceLimitPerUser",
    Source
  >;
}

const ERROR_COPY: Record<string, MessageKey> = {
  invalid_public_base_url: "installation.settings.err.invalidPublicBaseUrl",
  invalid_request: "installation.settings.err.invalidRequest",
  encryption_required: "installation.settings.err.encryptionRequired",
};

/**
 * A setting: its label and control, then one quiet line with where its value comes from and,
 * behind an (i), its help (still the control's aria-describedby through `hintId`).
 */
function Setting({
  label,
  source,
  hint,
  hintId,
  children,
}: {
  label: string;
  source: Source;
  hint?: string;
  hintId?: string;
  children: React.ReactNode;
}) {
  const t = useT();
  return (
    <div className="flex flex-col gap-2">
      {children}
      <p className="flex items-center gap-1 text-ui-xs text-text-muted">
        <span>{t("installation.settings.source", { source })}</span>
        {hint && <InfoTip label={label} text={hint} textId={hintId} />}
      </p>
    </div>
  );
}

export function SettingsForm({ initial }: { initial: SettingsView }) {
  const t = useT();
  const [saved, setSaved] = useState(initial);
  const [invitations, setInvitations] = useState(initial.invitationsEnabled);
  const [url, setUrl] = useState(initial.publicBaseUrl ?? "");
  const [llmOverride, setLlmOverride] = useState(initial.workspaceLlmOverride);
  const [limit, setLimit] = useState(String(initial.workspaceLimitPerUser));
  const limitValue = /^\d+$/.test(limit.trim()) ? Number(limit.trim()) : NaN;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const status = useRef<HTMLParagraphElement>(null);

  const dirty =
    invitations !== saved.invitationsEnabled ||
    url.trim() !== (saved.publicBaseUrl ?? "") ||
    llmOverride !== saved.workspaceLlmOverride ||
    limitValue !== saved.workspaceLimitPerUser;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setDone(false);
    // Only what changed: an untouched value must not turn an env value into a saved one.
    const patch: Record<string, unknown> = {};
    if (invitations !== saved.invitationsEnabled) patch.invitationsEnabled = invitations;
    if (url.trim() !== (saved.publicBaseUrl ?? "")) patch.publicBaseUrl = url.trim() || null;
    if (llmOverride !== saved.workspaceLlmOverride) patch.workspaceLlmOverride = llmOverride;
    if (limitValue !== saved.workspaceLimitPerUser) {
      if (!Number.isInteger(limitValue) || limitValue > 1000) {
        setError(t("installation.settings.limitInvalid"));
        return;
      }
      patch.workspaceLimitPerUser = limitValue;
    }
    setBusy(true);
    try {
      const res = await fetch("/dashboard/api/instance/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        setError(await failureMessage(t, res, ERROR_COPY));
        return;
      }
      const next = (await res.json()) as SettingsView;
      setSaved(next);
      setInvitations(next.invitationsEnabled);
      setUrl(next.publicBaseUrl ?? "");
      setLlmOverride(next.workspaceLlmOverride);
      setLimit(String(next.workspaceLimitPerUser));
      setDone(true);
    } catch {
      setError(t("errors.network"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <Section title={t("installation.settings.sectionInvitations")}>
        <div className="flex flex-col gap-6">
          <Setting
            label={t("installation.settings.invitationsEnabled")}
            source={saved.source.invitationsEnabled}
            hint={t("installation.settings.invitationsHint")}
            hintId="invitations-hint"
          >
            <Checkbox
              id="invitations-enabled"
              label={t("installation.settings.invitationsEnabled")}
              aria-describedby="invitations-hint"
              checked={invitations}
              onChange={(e) => {
                setInvitations(e.target.checked);
                setDone(false);
              }}
              disabled={busy}
            />
          </Setting>
          <Setting
            label={t("installation.settings.publicBaseUrl")}
            source={saved.source.publicBaseUrl}
            hint={t("installation.settings.publicBaseUrlHint")}
            hintId="public-base-url-hint"
          >
            <label htmlFor="public-base-url" className="text-ui font-medium text-text">
              {t("installation.settings.publicBaseUrl")}
            </label>
            <input
              id="public-base-url"
              type="url"
              inputMode="url"
              autoComplete="off"
              aria-describedby="public-base-url-hint"
              placeholder="https://mnemosyne.example.com/dashboard"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                setDone(false);
              }}
              disabled={busy}
              className={inputClass}
            />
          </Setting>
        </div>
      </Section>

      <Section title={t("installation.settings.sectionWorkspaces")}>
        <div className="flex flex-col gap-6">
          <Setting
            label={t("installation.settings.llmOverride")}
            source={saved.source.workspaceLlmOverride}
            hint={t("installation.settings.llmOverrideHint")}
            hintId="workspace-llm-override-hint"
          >
            <Checkbox
              id="workspace-llm-override"
              label={t("installation.settings.llmOverride")}
              aria-describedby="workspace-llm-override-hint"
              checked={llmOverride}
              onChange={(e) => {
                setLlmOverride(e.target.checked);
                setDone(false);
              }}
              disabled={busy}
            />
          </Setting>
          <Setting
            label={t("installation.settings.limit")}
            source={saved.source.workspaceLimitPerUser}
            hint={t("installation.settings.limitHint")}
            hintId="workspace-limit-hint"
          >
            <label htmlFor="workspace-limit" className="text-ui font-medium text-text">
              {t("installation.settings.limit")}
            </label>
            <input
              id="workspace-limit"
              type="number"
              min={0}
              max={1000}
              step={1}
              inputMode="numeric"
              aria-describedby="workspace-limit-hint"
              value={limit}
              onChange={(e) => {
                setLimit(e.target.value);
                setDone(false);
              }}
              disabled={busy}
              className={inputShort}
            />
          </Setting>
        </div>
      </Section>

      <Section title={t("installation.settings.registration")}>
        <Setting
          label={t("installation.settings.registration")}
          source={saved.source.registrationMode}
        >
          <p className="text-ui text-text-muted">{t("installation.settings.registrationClosed")}</p>
        </Setting>
      </Section>

      <Alert message={error} />
      {done && (
        <p ref={status} role="status" className="mt-4 text-ui text-green">
          {t("installation.settings.saved")}
        </p>
      )}
      <div className="mt-6">
        <button type="submit" disabled={busy || !dirty} className={primaryButton}>
          {busy ? t("common.saving") : t("installation.settings.save")}
        </button>
      </div>
    </form>
  );
}
