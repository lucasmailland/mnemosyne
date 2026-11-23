"use client";

import { useState } from "react";

import {
  Alert,
  failureMessage,
  ghostButton,
  inputClass,
  primaryButton,
} from "@/components/form-bits";
import { Field, RecordRow, Records, Section, StatusTag } from "@/components/keeper";
import { useT } from "@/lib/i18n/client";
import type { MessageKey } from "@/lib/i18n/core";
import { roleLabel, type WorkspaceRole } from "@/lib/roles";

export interface MyWorkspaces {
  workspaces: Array<{
    id: string;
    name: string;
    role: WorkspaceRole;
    isPersonal: boolean;
    current: boolean;
    /** Live memories under the session's ceiling; null when it could not be read. */
    factsLive?: number | null;
    lastWriteAt?: string | null;
    memberCount?: number | null;
  }>;
  ownedTeamCount: number;
  /** Team workspaces this person may own; null when there is no limit. */
  limit: number | null;
}

const ERROR_COPY: Record<string, MessageKey> = {
  invalid_name: "workspaces.err.invalidName",
  workspace_limit: "workspaces.err.workspaceLimit",
  workspace_not_found: "workspaces.err.workspaceNotFound",
  password_session_required: "workspaces.err.passwordSessionRequired",
};

/** Reload into the new session workspace: every page reads it from the cookie. */
const goHome = () => window.location.assign("/dashboard");

export function WorkspacesView({
  data,
  listInfo,
}: {
  data: MyWorkspaces;
  /** About the list, behind the (i) beside its heading (the superadmin's note). */
  listInfo?: React.ReactNode;
}) {
  const t = useT();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const atLimit = data.limit !== null && data.ownedTeamCount >= data.limit;

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/dashboard/api/my-workspaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      if (!res.ok) {
        setError(await failureMessage(t, res, ERROR_COPY));
        return;
      }
      goHome();
    } catch {
      setError(t("errors.network"));
    } finally {
      setBusy(false);
    }
  }

  async function open(id: string) {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/dashboard/api/my-workspaces/${encodeURIComponent(id)}/switch`, {
        method: "POST",
      });
      if (!res.ok) {
        setError(await failureMessage(t, res, ERROR_COPY));
        return;
      }
      goHome();
    } catch {
      setError(t("errors.network"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Section title={t("workspaces.listLabel")} info={listInfo}>
        <Records label={t("workspaces.listLabel")}>
          {data.workspaces.map((workspace) => (
            <RecordRow key={workspace.id}>
              <div className="min-w-0 flex-1 break-words text-ui font-medium">{workspace.name}</div>
              <StatusTag tone="accent">{roleLabel(t, workspace.role)}</StatusTag>
              {workspace.isPersonal && <StatusTag>{t("workspaces.personal")}</StatusTag>}
              {workspace.current ? (
                <span className="text-ui-xs text-text-muted">{t("workspaces.current")}</span>
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => open(workspace.id)}
                  aria-label={t("workspaces.openAria", { name: workspace.name })}
                  className={ghostButton}
                >
                  {t("workspaces.open")}
                </button>
              )}
            </RecordRow>
          ))}
        </Records>
      </Section>

      <Section title={t("workspaces.newTitle")} info={t("workspaces.newLead")}>
        {data.limit !== null && (
          <p className="mb-4 text-ui-sm text-text-muted">
            {t("workspaces.quota", { owned: data.ownedTeamCount, limit: data.limit })}
          </p>
        )}
        {atLimit ? (
          <p role="note" className="text-ui text-text-muted">
            {t("workspaces.atLimit")}
          </p>
        ) : (
          <form onSubmit={create} className="flex flex-wrap items-end gap-3">
            <div className="min-w-0 flex-1 basis-64">
              <Field label={t("workspaces.name")} htmlFor="workspace-name">
                <input
                  required
                  maxLength={100}
                  autoComplete="off"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={busy}
                  className={inputClass}
                />
              </Field>
            </div>
            <button type="submit" disabled={busy || !name.trim()} className={primaryButton}>
              {busy ? t("workspaces.creating") : t("workspaces.create")}
            </button>
          </form>
        )}
        <Alert message={error} />
      </Section>
    </>
  );
}
