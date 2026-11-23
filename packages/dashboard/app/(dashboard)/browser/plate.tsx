import { SensitivityBadge, KindPill, labelOr } from "@/components/badges";
import { ErrorState } from "@/components/error-state";
import { Meta } from "@/components/meta";
import { factStatement, fetchEpisode, isStr } from "@/lib/fetch-memory";
import { formatNumber, type Locale, type T } from "@/lib/i18n/core";
import { apiGet, getSession } from "@/lib/server-api";
import { shortId } from "@/lib/short-id";

import { Chain, type ChainFact } from "./chain";
import { FactActions, type MoveTarget } from "./fact-actions";
import { Clocks } from "./clocks";
import { writtenBy, type Fact, type FactDetail } from "./types";

const MAX_RELATED = 3;

const validDate = (v: unknown) => isStr(v) && !Number.isNaN(new Date(v).getTime());

const related = async (id: string): Promise<ChainFact> => ({
  id,
  statement: await factStatement(id),
});

export interface PlateData {
  d: FactDetail;
  workspace: string | null;
  episodeTitle: string | null;
  supersedes: ChainFact[];
  supersededBy: ChainFact | null;
  /** What the session may do to the fact; null when it is not live (nothing to act on). */
  actions: { canWrite: boolean; canDelete: boolean; targets: MoveTarget[] | null } | null;
}

/** Roles that may write in a workspace (routes/my-workspaces.ts). */
const WRITE_ROLES = new Set(["owner", "admin", "write"]);

/** The person's other workspaces they may write to; null without a password session. */
async function moveTargets(): Promise<MoveTarget[] | null> {
  const r = await apiGet<{ workspaces?: unknown }>("/my-workspaces");
  if (!Array.isArray(r?.workspaces)) return null;
  return r.workspaces.flatMap((w: Record<string, unknown>) =>
    w && isStr(w.id) && isStr(w.name) && w.current !== true && WRITE_ROLES.has(String(w.role))
      ? [{ id: w.id, name: w.name }]
      : []
  );
}

/** Everything the plate for ?open needs; null when the memory cannot be read (missing, or above the ceiling). */
export async function loadPlate(id: string): Promise<PlateData | null> {
  const d = await apiGet<FactDetail>(
    `/facts/${encodeURIComponent(id)}?includeClosed=true&provenance=true`
  );
  // The bridge answers whatever path it is given: only a real fact becomes a plate.
  if (!d || !isStr(d.id) || !isStr(d.content) || !validDate(d.validFrom) || !validDate(d.createdAt))
    return null;
  const [session, episode, supersededBy, supersedes] = await Promise.all([
    getSession(),
    isStr(d.episodeId) ? fetchEpisode(d.episodeId) : null,
    isStr(d.supersededById) ? related(d.supersededById) : null,
    Promise.all(
      (Array.isArray(d.supersedesIds) ? d.supersedesIds.filter(isStr) : [])
        .slice(0, MAX_RELATED)
        .map(related)
    ),
  ]);
  const live = d.validTo == null && (d.status ?? "active") === "active" && !isStr(d.supersededById);
  const scopes = session?.scopes ?? [];
  const canWrite = scopes.includes("memory:write");
  const actions = live
    ? {
        canWrite,
        canDelete: scopes.includes("memory:delete"),
        targets: canWrite && session?.authMethod === "password" ? await moveTargets() : null,
      }
    : null;
  return {
    d,
    actions,
    workspace: session?.workspaceName ?? null,
    episodeTitle: isStr(episode?.title) ? episode.title : null,
    supersedes,
    supersededBy,
  };
}

/** The detail plate of the memory named by ?open: statement, meta row, the two clocks, provenance. */
export function Plate({
  data,
  hit,
  t,
  locale,
}: {
  data: PlateData | null;
  hit: Fact | undefined;
  t: T;
  locale: Locale;
}) {
  if (!data) return <ErrorState title={t("browser.plate.label")} body={t("browser.plate.error")} />;
  const { d, workspace, episodeTitle, supersedes, supersededBy, actions } = data;
  const author = writtenBy(d) ?? (hit ? writtenBy(hit) : null);
  const kind = d.kind ?? hit?.kind;
  const sensitivity = d.sensitivity ?? hit?.sensitivity;
  const confidence = d.confidence ?? hit?.confidence;
  const hitCount = d.hitCount ?? hit?.hitCount;
  // A fact replaced by another is closed as forgotten on the server; it reads as superseded.
  const status = isStr(d.supersededById) ? "superseded" : d.status;

  return (
    <article aria-labelledby="catalog-statement">
      <p className="text-text-faint text-mono flex flex-wrap items-center gap-x-3 gap-y-1 font-mono">
        <span>{shortId(d.id)}</span>
        {kind && <KindPill label={labelOr(t, `browser.kind.${kind}`, kind)} />}
        {status && status !== "active" && (
          <span>{labelOr(t, `browser.status.${status}`, status)}</span>
        )}
        <span className="break-all">{d.id}</span>
      </p>
      <h2
        id="catalog-statement"
        tabIndex={-1}
        className="font-display text-display-4 echo mt-3 mb-4 max-w-2xl leading-tight font-normal break-words"
      >
        {d.content}
      </h2>
      <dl className="border-border flex flex-wrap gap-x-6 gap-y-3 border-b pb-4">
        {author && (
          <Meta label={t("browser.meta.writtenBy")}>
            <span className={author.id ? "font-mono" : undefined}>{author.text}</span>
          </Meta>
        )}
        {workspace && <Meta label={t("browser.meta.workspace")}>{workspace}</Meta>}
        {confidence != null && (
          <Meta label={t("browser.meta.confidence")}>{formatNumber(locale, confidence, 2)}</Meta>
        )}
        {hitCount != null && (
          <Meta label={t("browser.meta.cited")}>{t("browser.recalls", { count: hitCount })}</Meta>
        )}
        {sensitivity && (
          <Meta label={t("browser.meta.sensitivity")}>
            <SensitivityBadge
              tier={sensitivity}
              label={labelOr(t, `browser.sensitivity.${sensitivity}`, sensitivity)}
            />
          </Meta>
        )}
      </dl>
      {actions && (
        <FactActions
          id={d.id}
          statement={d.content}
          pinned={d.pinned === true}
          revision={typeof d.revisionCount === "number" ? d.revisionCount : undefined}
          {...actions}
        />
      )}
      <Clocks
        t={t}
        locale={locale}
        validFrom={d.validFrom}
        validTo={d.validTo}
        createdAt={d.createdAt}
        supersededAt={d.supersededAt ?? null}
        now={new Date()}
      />
      <Chain
        t={t}
        sessionId={d.sessionId ?? null}
        episode={d.episodeId ? { id: d.episodeId, title: episodeTitle } : null}
        self={d.id}
        supersedes={supersedes}
        supersededBy={supersededBy}
      />
    </article>
  );
}
