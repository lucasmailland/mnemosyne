import { AccessDenied } from "@/components/access-denied";
import { labelOr } from "@/components/badges";
import { getLocale, getT, roomTitle } from "@/lib/i18n/server";
import { apiGet, apiRead } from "@/lib/server-api";
import type { ReactNode } from "react";

import { RecordRow, Records, Section, StatusDot, type Tone } from "@/components/keeper";
import { formatDate, formatNumber, formatRelative } from "@/lib/i18n/core";

import { HealthFigures, parseHistory, parseSnapshots } from "./figures";

/**
 * Admin — System Health (spec §4.8): /doctor checks + workspace vitals (the bridge serves
 * them at /health, packages/server/src/routes/health.ts mountVitals).
 */

interface DoctorReport {
  status: "ok" | "warn" | "error" | "unknown";
  checks: Array<{
    name: string;
    status: "ok" | "warn" | "error" | "unknown";
    message?: string;
    latencyMs?: number;
  }>;
  timestamp: string;
}

interface Vitals {
  factsLive?: number;
  factsClosed?: number;
  pinnedCount?: number;
  embeddings?: { indexed: number; pending: number };
  lastRecallAt?: string | null;
  lastWriteAt?: string | null;
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string";

/** The doctor's report, validated at the edge: a wrong shape is a load error, never a crash. */
export function parseDoctor(v: unknown): DoctorReport | null {
  if (!rec(v) || !str(v.status) || !Array.isArray(v.checks)) return null;
  const checks: DoctorReport["checks"] = [];
  for (const c of v.checks) {
    if (!rec(c) || !str(c.name) || !str(c.status)) continue;
    checks.push({
      name: c.name,
      status: c.status as DoctorReport["status"],
      ...(str(c.message) ? { message: c.message } : {}),
      ...(typeof c.latencyMs === "number" ? { latencyMs: c.latencyMs } : {}),
    });
  }
  return {
    status: v.status as DoctorReport["status"],
    checks,
    timestamp: str(v.timestamp) ? v.timestamp : "",
  };
}

/** Doctor statuses (packages/server/src/routes/doctor.ts: ok | warn | error | unknown) → tone. */
const STATUS_TONE: Record<string, Tone> = { ok: "good", warn: "warn", error: "bad" };
const toneOf = (status: string): Tone => STATUS_TONE[status] ?? "neutral";

export const generateMetadata = roomTitle("health");

/** Past this many characters a check's message shows one line and opens on request. */
const LONG_MESSAGE = 72;

export default async function HealthPage() {
  const t = await getT();
  const [doctorRead, rawVitals, rawSnapshots, rawHistory] = await Promise.all([
    apiRead<unknown>("/doctor"),
    apiGet<unknown>("/health"),
    apiGet<unknown>("/health/snapshots?days=30"),
    apiGet<unknown>("/health/history"),
  ]);
  // The doctor is an operator view: a 403 means the reader lacks the permission (APP-040).
  if (doctorRead.status === 403) return <AccessDenied t={t} scope="memory:admin" />;
  const doctor = parseDoctor(doctorRead.data);
  const vitals = rec(rawVitals) ? (rawVitals as Vitals) : null;

  const locale = await getLocale();
  const statusLabel = (status: string) =>
    labelOr(t, `health.status.${status}`, t("health.status.unknown"));
  const num = (n: number | undefined) => (n === undefined ? "—" : formatNumber(locale, n));
  const when = (iso: string | null | undefined) =>
    iso === undefined ? (
      "—"
    ) : iso === null ? (
      t("common.never")
    ) : (
      <time dateTime={iso} title={formatDate(locale, iso, "datetime")}>
        {formatRelative(locale, iso)}
      </time>
    );
  const tiles: Array<[string, ReactNode]> = vitals
    ? [
        [t("health.factsLive"), num(vitals.factsLive)],
        [t("health.factsClosed"), num(vitals.factsClosed)],
        [t("health.pinned"), num(vitals.pinnedCount)],
        [
          t("health.embeddings"),
          <>
            {num(vitals.embeddings?.indexed)}
            {vitals.embeddings && vitals.embeddings.pending > 0 && (
              <span className="ml-2 font-sans text-ui-xs text-yellow">
                {t("health.pending", { count: formatNumber(locale, vitals.embeddings.pending) })}
              </span>
            )}
          </>,
        ],
        [t("health.lastRecall"), when(vitals.lastRecallAt)],
        [t("health.lastWrite"), when(vitals.lastWriteAt)],
      ]
    : [];

  return (
    <div className="w-full">
      <HealthFigures
        t={t}
        locale={locale}
        checks={doctor?.checks ?? null}
        embeddings={vitals?.embeddings ?? null}
        snapshots={parseSnapshots(rawSnapshots)}
        history={parseHistory(rawHistory)}
      />
      {doctor && (
        <p className="mb-2 flex flex-wrap items-center gap-2 text-ui font-medium">
          <span className="text-text-muted">{t("health.overall")}</span>
          <StatusDot tone={toneOf(doctor.status)} label={statusLabel(doctor.status)} />
        </p>
      )}

      <Section title={t("health.checksTitle")}>
        {!doctor ? (
          <p className="text-ui text-text-muted">
            {doctorRead.timedOut ? t("common.timeout") : t("health.checksError")}
          </p>
        ) : (
          <Records label={t("health.checksTitle")}>
            {doctor.checks.map((check) => (
              <RecordRow key={check.name}>
                <span className="min-w-32 shrink-0 whitespace-nowrap">
                  <StatusDot tone={toneOf(check.status)} label={statusLabel(check.status)} />
                </span>
                <span className="min-w-0 font-mono text-mono wrap-anywhere sm:w-56 sm:shrink-0">
                  {check.name}
                </span>
                {/* Phones: the message takes its own line. A long one shows its first line and opens
                    in place (a native disclosure: keyboard and screen readers get all of it). */}
                {(check.message?.length ?? 0) > LONG_MESSAGE ? (
                  <details className="group min-w-0 basis-full sm:flex-1">
                    <summary className="block cursor-pointer truncate text-ui-xs text-text-muted group-open:whitespace-normal group-open:wrap-anywhere focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
                      {check.message}
                    </summary>
                  </details>
                ) : (
                  <span className="min-w-0 basis-full text-ui-xs text-text-muted wrap-anywhere sm:flex-1">
                    {check.message ?? ""}
                  </span>
                )}
                {check.latencyMs !== undefined && (
                  <span className="shrink-0 font-mono text-mono text-text-muted">
                    {check.latencyMs}ms
                  </span>
                )}
              </RecordRow>
            ))}
          </Records>
        )}
      </Section>

      <Section title={t("health.vitalsTitle")}>
        {!vitals ? (
          <p className="text-ui text-text-muted">{t("health.vitalsError")}</p>
        ) : (
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            {tiles.map(([label, value]) => (
              <div key={label} className="border border-border bg-surface px-4 py-3">
                <dt className="eyebrow">{label}</dt>
                <dd className="mt-1 font-display text-display-4 leading-tight tabular-nums">
                  {value}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </Section>
    </div>
  );
}
