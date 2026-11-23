import { getLocale, getT, roomTitle } from "@/lib/i18n/server";
import { Section } from "@/components/keeper";
import { apiGet, getSession } from "@/lib/server-api";

import { parseFactStatsFull } from "@/lib/metrics";

import { ConfigFigures, type Retention } from "./figures";
import { LlmConfigForm, LlmConfigSummary, WorkspaceModeForm } from "./forms";

/**
 * Workspace Config (spec §4.6): LLM provider (masked key, write-only),
 * workspace learning/production mode, and read-only workspace info.
 *
 * The model is the installation's unless the server says this caller may
 * override it (`canEdit`): installation admins always, workspace owners and
 * admins only when Installation > Settings allows it. Workspace mode needs
 * the admin role.
 */

export interface LlmConfig {
  provider: string | null;
  apiKey?: string;
  embedModel?: string;
  llmModel?: string;
  temperature?: number;
  maxTokens?: number;
  embedDimensions?: number;
  embedBatchSize?: number;
  baseUrl?: string;
  source: "workspace" | "global" | "env";
  /** This caller may set or remove the workspace override. */
  canEdit?: boolean;
  editPolicy?: "installation" | "workspace_owners";
}

export interface WorkspaceMode {
  mode: "learning" | "production";
  sessionCount: number;
  promoteAt: number | null;
  startedAt: string | null;
  factCount: number;
  entityCount: number;
}

export const generateMetadata = roomTitle("config");

export default async function ConfigPage() {
  const t = await getT();
  const locale = await getLocale();
  const [session, llm, mode, rawFacts, retention, stats] = await Promise.all([
    getSession(),
    apiGet<LlmConfig>("/config/llm"),
    apiGet<WorkspaceMode>("/workspace-mode"),
    apiGet<unknown>("/facts/stats"),
    // Admin-only reads: a member gets null and the figures that need them are left out.
    apiGet<Retention>("/admin/config/retention"),
    apiGet<{ embeddings?: { indexed: number; pending: number } }>("/admin/stats"),
  ]);
  const canEdit = session?.role === "admin";

  return (
    <div className="w-full">
      <ConfigFigures
        t={t}
        locale={locale}
        mode={mode}
        facts={parseFactStatsFull(rawFacts)}
        retention={typeof retention?.transcriptDays === "number" ? retention : null}
        embeddings={stats?.embeddings ?? null}
      />
      {!canEdit && (
        <p role="note" className="text-ui text-text-muted">
          {t("config.readOnly")}
        </p>
      )}

      <Section title={t("config.llmTitle")}>
        {llm === null ? (
          <p className="text-ui text-text-muted">{t("config.llmLoadError")}</p>
        ) : llm.canEdit ? (
          <LlmConfigForm initial={llm} canEdit />
        ) : (
          <LlmConfigSummary config={llm} />
        )}
      </Section>

      <Section title={t("config.modeTitle")} info={t("config.modeCounters")}>
        {mode === null ? (
          <p className="text-ui text-text-muted">{t("config.modeLoadError")}</p>
        ) : (
          <WorkspaceModeForm initial={mode} canEdit={canEdit} />
        )}
      </Section>

      <Section title={t("config.infoTitle")}>
        <dl className="space-y-2 text-ui">
          <div className="flex gap-3">
            <dt className="w-40 shrink-0 text-text-muted">{t("config.workspaceId")}</dt>
            <dd className="font-mono text-mono-sm">{session?.workspaceId}</dd>
          </div>
          <div className="flex gap-3">
            <dt className="w-40 shrink-0 text-text-muted">{t("config.plan")}</dt>
            <dd className="capitalize">{session?.plan}</dd>
          </div>
          {session?.authMethod !== "password" && (
            <div className="flex gap-3">
              <dt className="w-40 shrink-0 text-text-muted">{t("config.keyPrefix")}</dt>
              <dd className="font-mono text-mono-sm">{session?.keyPrefix}…</dd>
            </div>
          )}
        </dl>
      </Section>
    </div>
  );
}
