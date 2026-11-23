"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";

import {
  Alert,
  dangerGhostButton,
  ghostButton,
  inputClass,
  inputShort,
  primaryButton,
  selectClass,
} from "@/components/form-bits";
import { ConfirmDialog, Field } from "@/components/keeper";
import { InfoTip } from "@/components/ui/info-tip";
import { useT } from "@/lib/i18n/client";
import type { MessageKey } from "@/lib/i18n/core";

import type { LlmConfig, WorkspaceMode } from "./page";

/**
 * Client forms for the Config page. All mutations go through the same-origin
 * /dashboard/api proxy (session cookie auth). Key field is write-only: the
 * server returns it masked, the form only sends a value when changed.
 */

const PROVIDERS = ["openai", "google", "cohere", "mistral", "voyage", "ollama", "bedrock"];

/** The outcome of the last save: an error takes focus, a success is announced politely. */
function Feedback({ state }: { state: { ok?: string; error?: string } }) {
  return (
    <>
      <Alert message={state.error ?? null} />
      {state.ok && (
        <p role="status" className="mt-3 text-ui text-green">
          {state.ok}
        </p>
      )}
    </>
  );
}

const SOURCE_COPY: Record<LlmConfig["source"], MessageKey> = {
  env: "config.sourceEnv",
  global: "config.sourceGlobal",
  workspace: "config.sourceWorkspace",
};

/**
 * Read-only view for anyone who may not change the model: which provider and
 * models this workspace's memories go through, and who sets them.
 */
export function LlmConfigSummary({ config }: { config: LlmConfig }) {
  const t = useT();
  const rows: Array<[string, string | undefined]> = [
    [t("config.provider"), config.provider ?? undefined],
    [t("config.llmModel"), config.llmModel],
    [t("config.embedModel"), config.embedModel],
  ];
  return (
    <div>
      <p className="text-ui text-text-muted flex items-center gap-1">
        {t("config.setBy", { source: t(SOURCE_COPY[config.source]) })}
        <InfoTip
          label={t("config.whoChanges")}
          text={
            config.editPolicy === "workspace_owners"
              ? t("config.canChangeOwners")
              : t("config.canChangeSuperadmin")
          }
        />
      </p>
      <dl className="mt-4 space-y-2 text-ui">
        {rows.map(([label, value]) => (
          <div key={label} className="flex gap-3">
            <dt className="w-36 shrink-0 text-text-muted">{label}</dt>
            <dd className="min-w-0 break-words font-mono text-mono-sm">
              {value ?? t("config.providerDefault")}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function LlmConfigForm({ initial, canEdit }: { initial: LlmConfig; canEdit: boolean }) {
  const t = useT();
  const router = useRouter();
  const [provider, setProvider] = useState(initial.provider ?? "openai");
  const [llmModel, setLlmModel] = useState(initial.llmModel ?? "");
  const [embedModel, setEmbedModel] = useState(initial.embedModel ?? "");
  const [apiKey, setApiKey] = useState(""); // write-only — empty = unchanged
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl ?? "");
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<{ ok?: string; error?: string }>({});
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  const changingEmbed = embedModel !== (initial.embedModel ?? "") && !!initial.embedModel;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setState({});
    setBusy(true);
    try {
      const body: Record<string, unknown> = { provider, llmModel, embedModel };
      if (apiKey.trim()) body.apiKey = apiKey.trim();
      if (baseUrl.trim()) body.baseUrl = baseUrl.trim();
      const res = await fetch("/dashboard/api/config/llm", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => ({}))) as {
        warning?: string;
        message?: string;
        error?: { message?: string } | string;
      };
      if (res.ok) {
        setState({
          ok: json.warning
            ? t("config.savedWarning", { warning: json.warning })
            : t("config.saved"),
        });
        setApiKey("");
        router.refresh();
      } else {
        const msg =
          json.message ??
          (typeof json.error === "string" ? json.error : json.error?.message) ??
          t("errors.httpStatus", { status: res.status });
        setState({ error: msg });
      }
    } catch {
      setState({ error: t("errors.network") });
    } finally {
      setBusy(false);
    }
  }

  async function removeOverride() {
    setBusy(true);
    setState({});
    try {
      const res = await fetch("/dashboard/api/config/llm", { method: "DELETE" });
      if (res.ok) {
        setState({ ok: t("config.overrideRemoved") });
        router.refresh();
      } else {
        setState({ error: t("errors.httpStatus", { status: res.status }) });
      }
    } catch {
      setState({ error: t("errors.network") });
    } finally {
      setBusy(false);
      setConfirmingRemove(false);
    }
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-4">
      <div className="text-ui-xs text-text-muted">
        {t("config.inUse", { source: t(SOURCE_COPY[initial.source]) })}
        {initial.llmModel && (
          <>
            {" · "}
            {t("config.inUseModel")} <span className="font-mono">{initial.llmModel}</span>
          </>
        )}
        {initial.apiKey && (
          <>
            {" · "}
            {t("config.inUseKey")} <span className="font-mono">{initial.apiKey}</span>
          </>
        )}
      </div>

      <Field label={t("config.provider")}>
        <select
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
          disabled={!canEdit}
          className={selectClass}
        >
          {PROVIDERS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </Field>

      <Field label={t("config.llmModel")}>
        <input
          value={llmModel}
          onChange={(e) => setLlmModel(e.target.value)}
          disabled={!canEdit}
          className={inputClass}
          placeholder={t("config.providerDefault")}
        />
      </Field>

      <Field label={t("config.embedModel")}>
        <input
          value={embedModel}
          onChange={(e) => setEmbedModel(e.target.value)}
          disabled={!canEdit}
          className={inputClass}
          placeholder={t("config.providerDefault")}
        />
      </Field>
      {changingEmbed && <p className="text-ui-xs text-yellow">{t("config.embedWarning")}</p>}

      <Field label={t("config.apiKeyWriteOnly")}>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          disabled={!canEdit}
          className={inputClass}
          placeholder={initial.apiKey ? t("config.apiKeyKeep") : "sk-…"}
          autoComplete="off"
        />
      </Field>

      {provider === "ollama" && (
        <Field label={t("config.baseUrl")}>
          <input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            disabled={!canEdit}
            className={inputClass}
            placeholder="http://localhost:11434"
          />
        </Field>
      )}

      <Feedback state={state} />

      {canEdit && (
        <div className="flex flex-wrap gap-3">
          <button type="submit" disabled={busy} className={primaryButton}>
            {busy ? t("common.saving") : t("config.saveChanges")}
          </button>
          {initial.source === "workspace" && (
            <button
              type="button"
              onClick={() => setConfirmingRemove(true)}
              disabled={busy}
              className={dangerGhostButton}
            >
              {t("config.removeOverride")}
            </button>
          )}
        </div>
      )}
      <ConfirmDialog
        open={confirmingRemove}
        title={t("config.removeOverrideTitle")}
        body={t("config.removeOverrideBody")}
        confirmLabel={t("config.removeOverride")}
        tone="danger"
        busy={busy}
        onConfirm={removeOverride}
        onClose={() => setConfirmingRemove(false)}
      />
    </form>
  );
}

export function WorkspaceModeForm({
  initial,
  canEdit,
}: {
  initial: WorkspaceMode;
  canEdit: boolean;
}) {
  const t = useT();
  const router = useRouter();
  const [promoteAt, setPromoteAt] = useState(initial.promoteAt?.toString() ?? "");
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<{ ok?: string; error?: string }>({});

  async function put(body: Record<string, unknown>, okMsg: string) {
    setBusy(true);
    setState({});
    try {
      const res = await fetch("/dashboard/api/workspace-mode", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        setState({ ok: okMsg });
        router.refresh();
      } else if (res.status === 403) {
        setState({ error: t("config.scopeRequired") });
      } else {
        setState({ error: t("errors.httpStatus", { status: res.status }) });
      }
    } catch {
      setState({ error: t("errors.network") });
    } finally {
      setBusy(false);
    }
  }

  const stats: Array<[string, ReactNode]> = [
    [t("config.mode"), initial.mode === "learning" ? t("config.learning") : t("config.production")],
    [t("config.sessions"), initial.sessionCount],
    [t("config.facts"), initial.factCount],
    [t("config.entities"), initial.entityCount],
  ];
  return (
    <div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
        {stats.map(([label, value]) => (
          <div key={label}>
            <dt className="eyebrow">{label}</dt>
            <dd className="mt-1 text-ui tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>

      {canEdit && (
        <div className="mt-6 flex flex-wrap items-end gap-3">
          <Field label={t("config.promoteAt")} info={t("config.promoteAtHint")}>
            <input
              type="number"
              min={1}
              value={promoteAt}
              onChange={(e) => setPromoteAt(e.target.value)}
              className={inputShort}
              placeholder={t("config.promoteAuto")}
            />
          </Field>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              put(
                { promoteAt: promoteAt.trim() === "" ? null : Number(promoteAt) },
                t("config.thresholdSaved")
              )
            }
            className={ghostButton}
          >
            {t("config.saveThreshold")}
          </button>
          {initial.mode === "learning" ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => put({ mode: "production" }, t("config.promoted"))}
              className={primaryButton}
            >
              {t("config.promoteToProduction")}
            </button>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() => put({ mode: "learning" }, t("config.backInLearning"))}
              className={ghostButton}
            >
              {t("config.backToLearning")}
            </button>
          )}
        </div>
      )}

      <Feedback state={state} />
    </div>
  );
}
