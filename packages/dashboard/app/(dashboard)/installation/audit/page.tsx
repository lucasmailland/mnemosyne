import Form from "next/form";
import Link from "next/link";
import type { ReactNode } from "react";

import { labelOr } from "@/components/badges";
import { RecordRow, Records, Section, StatusTag } from "@/components/keeper";
import { DateRangeMenu } from "@/components/ui/date-range-menu";
import { FilterBar, SearchInput } from "@/components/ui/filter-bar";
import { FilterMenu } from "@/components/ui/filter-menu";
import { SECURITY_AUDIT_ACTIONS } from "@/lib/audit-actions";
import { auditApiQuery, auditPageQuery, validDay } from "@/lib/audit-filters";
import { formatDate } from "@/lib/i18n/core";
import { getLocale, getT } from "@/lib/i18n/server";
import { installationTitle } from "@/lib/i18n/installation-title";
import { apiGet, requireSuperadmin } from "@/lib/server-api";
import { ghostButton } from "@/components/form-bits";

import { SecurityFigures, parseSecurityStats } from "../figures";

/**
 * Installation — Security audit: sign-ins, account and membership changes,
 * settings, key lifecycle and workspace openings, newest first. Filters and
 * the page cursor live in the URL. Superadmins only.
 */

interface Entry {
  id: string;
  workspaceId: string;
  actorType: string;
  actorId: string;
  actorEmail: string | null;
  action: string;
  resourceKind: string;
  resourceId: string | null;
  detail: Record<string, unknown> | null;
  createdAt: string;
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
/** Payload keys whose values are codes with a label: key → dictionary prefix. */
const VALUE_LABELS: Record<string, string> = {
  role: "roles",
  purpose: "installation.audit.values.purpose",
  via: "installation.audit.values.purpose",
  reason: "installation.audit.values.reason",
  change: "installation.audit.values.change",
  keyKind: "installation.audit.values.keyKind",
};

export const generateMetadata = installationTitle("installation-audit");

export default async function SecurityAuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requireSuperadmin();
  const { action, actor, from, to, cursor } = await searchParams;
  const filters = { action, actor, from, to };
  const [data, rawStats] = await Promise.all([
    apiGet<{ entries: Entry[]; nextCursor: string | null }>(
      `/instance/audit${auditApiQuery({ ...filters, cursor })}`
    ),
    apiGet<unknown>("/instance/audit/stats?days=30"),
  ]);

  const t = await getT();
  const locale = await getLocale();
  const actionName = (code: string) => labelOr(t, `installation.audit.actions.${code}`, code);
  /** The label for a key, or null when the dictionary has none (the raw code shows as code). */
  const known = (key: string): string | null => {
    const out = labelOr(t, key, "");
    return out === "" ? null : out;
  };
  const Code = ({ children }: { children: string }) => (
    <code className="font-mono text-mono break-all">{children}</code>
  );
  /** A payload value: a labelled code, a time, yes/no, or the raw value as code. */
  const detailValue = (key: string, value: unknown): ReactNode => {
    if (typeof value === "boolean") return t(`installation.audit.values.${value ? "yes" : "no"}`);
    if (typeof value === "string") {
      const prefix = VALUE_LABELS[key];
      const label = prefix ? known(`${prefix}.${value}`) : null;
      if (label) return label;
      if (ISO_INSTANT.test(value) && !Number.isNaN(Date.parse(value)))
        return formatDate(locale, value, "datetime");
      return <Code>{value}</Code>;
    }
    if (typeof value === "number") return String(value);
    if (Array.isArray(value)) return <Code>{value.map(String).join(", ")}</Code>;
    return <Code>{JSON.stringify(value)}</Code>;
  };
  return (
    <div className="w-full">
      <SecurityFigures t={t} stats={parseSecurityStats(rawStats)} />
      <Section title={t("installation.audit.filtersTitle")} info={t("lead.installationAudit")}>
        {/* One row: actor, action, days, Clear. A GET form (next/form: client-side), so the
            filters and the page cursor stay in the URL under the same names; the action applies
            on a pick, the days with their Apply, the actor with Enter. Keyed by the filters, so
            Clear empties the fields. */}
        <div key={JSON.stringify(filters)}>
          <Form action="/installation/audit" aria-label={t("installation.audit.filterAria")}>
            <FilterBar
              label={t("installation.audit.filtersTitle")}
              search={
                <SearchInput
                  name="actor"
                  defaultValue={actor ?? ""}
                  autoComplete="off"
                  aria-label={t("installation.audit.actor")}
                  placeholder={t("installation.audit.actor")}
                />
              }
              active={[action, actor?.trim(), from || to].filter(Boolean).length}
              clearHref="/installation/audit"
            >
              <FilterMenu
                label={t("installation.audit.action")}
                name="action"
                allLabel={t("installation.audit.allActions")}
                options={SECURITY_AUDIT_ACTIONS.map((a) => ({ value: a, label: actionName(a) }))}
                defaultValue={action ? [action] : []}
                submitOnChange
              />
              <DateRangeMenu
                from={validDay(from) ? from : undefined}
                to={validDay(to) ? to : undefined}
              />
            </FilterBar>
          </Form>
        </div>
      </Section>

      <Section title={t("installation.audit.entriesTitle")}>
        {!data ? (
          <p className="text-ui text-text-muted">{t("installation.audit.loadError")}</p>
        ) : data.entries.length === 0 ? (
          <p className="text-ui text-text-muted">{t("installation.audit.noEntries")}</p>
        ) : (
          <Records label={t("installation.audit.listLabel")}>
            {data.entries.map((entry) => (
              <RecordRow key={entry.id}>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                    {/* The localized name is what shows; the raw code stays in the text for
                        assistive technology and in the tooltip. */}
                    <span title={entry.action}>
                      <StatusTag tone="accent" caseless>
                        {actionName(entry.action)}
                        <span className="sr-only"> ({entry.action})</span>
                      </StatusTag>
                    </span>
                    <time dateTime={entry.createdAt} className="text-ui-xs text-text-muted">
                      {formatDate(locale, entry.createdAt, "datetime")}
                    </time>
                  </div>
                  <div className="mt-2 wrap-anywhere text-ui">
                    {entry.actorEmail ?? `${entry.actorType}:${entry.actorId}`}
                    <span className="text-text-muted">
                      {" "}
                      →{" "}
                      {known(`installation.audit.resources.${entry.resourceKind}`) ?? (
                        <Code>{entry.resourceKind}</Code>
                      )}
                      {entry.resourceId ? ` ${entry.resourceId}` : ""}
                    </span>
                  </div>
                  {entry.detail && Object.keys(entry.detail).length > 0 && (
                    <dl className="mt-1 flex flex-wrap gap-x-4 gap-y-1 wrap-anywhere text-ui-xs text-text-muted">
                      {Object.entries(entry.detail).map(([key, value]) => {
                        const label = known(`installation.audit.fields.${key}`);
                        return (
                          <div key={key}>
                            <dt className="inline">
                              {label ? `${label}:` : <Code>{`${key}:`}</Code>}
                            </dt>{" "}
                            <dd className="inline">{detailValue(key, value)}</dd>
                          </div>
                        );
                      })}
                    </dl>
                  )}
                </div>
              </RecordRow>
            ))}
          </Records>
        )}

        {data && (cursor || data.nextCursor) && (
          <nav
            aria-label={t("installation.audit.pagesLabel")}
            className="mt-5 flex flex-wrap gap-3"
          >
            {cursor && (
              <Link href={`/installation/audit${auditPageQuery(filters)}`} className={ghostButton}>
                {t("installation.audit.newest")}
              </Link>
            )}
            {data.nextCursor && (
              <Link
                href={`/installation/audit${auditPageQuery({ ...filters, cursor: data.nextCursor })}`}
                className={ghostButton}
              >
                {t("installation.audit.older")}
              </Link>
            )}
          </nav>
        )}
      </Section>
    </div>
  );
}
