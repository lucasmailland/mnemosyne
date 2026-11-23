import Link from "next/link";

import { labelOr } from "@/components/badges";
import { ErrorState } from "@/components/error-state";
import { Meta } from "@/components/meta";
import { episodeOf, factStatement, isStr } from "@/lib/fetch-memory";
import { formatDate, type Locale, type T } from "@/lib/i18n/core";
import { apiGet, apiRead } from "@/lib/server-api";
import { shortId } from "@/lib/short-id";

import type { Episode } from "./types";
import { parseEpisode } from "./types";

const MAX_FACTS = 10;
const MAX_PARTICIPANTS = 8;

interface TimelineEvent {
  kind: string;
  occurredAt: string;
}
interface ProducedFact {
  id: string;
  statement: string | null;
}
export interface NicheData {
  episode: Episode;
  timeline: TimelineEvent[] | null;
  facts: ProducedFact[];
}

/** Why ?open shows no niche: a malformed id (the server's 400), or any other failure. */
export type NicheFailure = "invalid" | "unavailable";

/**
 * Everything ?open needs, or why it cannot be shown: "invalid" for an id the server
 * rejects as malformed (400), "unavailable" when the episode cannot be read (missing,
 * above the ceiling, an error, or an unexpected shape).
 */
export async function loadNiche(id: string): Promise<NicheData | NicheFailure> {
  const [detail, timeline] = await Promise.all([
    apiRead<{ episode?: unknown }>(`/episodes/${encodeURIComponent(id)}`),
    apiGet<{ events?: unknown }>(`/episodes/${encodeURIComponent(id)}/timeline`),
  ]);
  if (detail.status === 400) return "invalid";
  const episode = parseEpisode(episodeOf(detail.data));
  if (!episode) return "unavailable";
  // Bounded fan-out: at most MAX_FACTS fetches, in parallel; one failure leaves the rest.
  const facts = await Promise.all(
    episode.linkedFactIds
      .slice(0, MAX_FACTS)
      .map(async (fid): Promise<ProducedFact> => ({ id: fid, statement: await factStatement(fid) }))
  );
  const events = Array.isArray(timeline?.events)
    ? timeline.events.filter(
        (e): e is TimelineEvent =>
          !!e &&
          typeof e === "object" &&
          isStr((e as TimelineEvent).kind) &&
          isStr((e as TimelineEvent).occurredAt) &&
          !Number.isNaN(new Date((e as TimelineEvent).occurredAt).getTime())
      )
    : null;
  return { episode, timeline: events, facts };
}

/** The open niche: narrative, participants, session id, timeline and the facts the session produced. */
export function Niche({
  data,
  t,
  locale,
}: {
  data: NicheData | NicheFailure;
  t: T;
  locale: Locale;
}) {
  if (typeof data === "string")
    return (
      <ErrorState
        title={t("sessions.nicheLabel")}
        body={t(data === "invalid" ? "sessions.invalidId" : "sessions.error")}
      />
    );
  const { episode: ep, timeline, facts } = data;
  const left = ep.linkedFactIds.length - facts.length;
  return (
    <article aria-labelledby="columbarium-title">
      <h2
        id="columbarium-title"
        tabIndex={-1}
        className="font-display text-display-4 echo mb-3 max-w-2xl leading-tight font-normal break-words"
      >
        {ep.title}
      </h2>
      {ep.narrative && (
        <>
          <h3 className="eyebrow mb-2">{t("sessions.narrative")}</h3>
          <p className="text-text max-w-2xl text-ui leading-relaxed break-words whitespace-pre-wrap">
            {ep.narrative}
          </p>
        </>
      )}
      <dl className="border-border mt-4 flex flex-wrap gap-x-6 gap-y-3 border-y py-4">
        {ep.participants.length > 0 && (
          <Meta label={t("sessions.participants")}>
            {ep.participants.slice(0, MAX_PARTICIPANTS).join(", ")}
            {ep.participants.length > MAX_PARTICIPANTS &&
              ` ${t("sessions.more", { count: ep.participants.length - MAX_PARTICIPANTS })}`}
          </Meta>
        )}
        {ep.sourceConversationId && (
          <Meta label={t("sessions.sessionId")}>
            <span className="font-mono text-mono break-all">{ep.sourceConversationId}</span>
          </Meta>
        )}
      </dl>

      <h3 className="eyebrow mt-6 mb-3">{t("sessions.timeline")}</h3>
      {timeline && timeline.length > 0 ? (
        <ol data-testid="columbarium-timeline" className="border-border space-y-2 border-l pl-4">
          {timeline.map((e, i) => (
            <li key={i} className="text-ui-sm">
              <span className="text-text-muted text-ui-xs mr-3 font-mono">
                {formatDate(locale, e.occurredAt, "datetime")}
              </span>
              {labelOr(t, `sessions.event.${e.kind}`, e.kind)}
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-text-muted text-ui-sm">
          {t(timeline ? "sessions.noTimeline" : "sessions.timelineError")}
        </p>
      )}

      <h3 className="eyebrow mt-6 mb-3">{t("sessions.produced")}</h3>
      {facts.length > 0 ? (
        <ul className="space-y-2">
          {facts.map((f) =>
            f.statement ? (
              <li key={f.id}>
                <Link
                  href={`/browser?open=${encodeURIComponent(f.id)}`}
                  className="atrium-link text-ui-sm break-words"
                >
                  <span className="text-mono-sm font-mono">{shortId(f.id)}</span>
                  <span className="ml-2">{f.statement}</span>
                </Link>
              </li>
            ) : (
              <li key={f.id} className="text-text-muted text-ui-sm">
                <span className="text-mono-sm font-mono">{shortId(f.id)}</span>
                <span className="ml-2">{t("sessions.factUnavailable")}</span>
              </li>
            )
          )}
          {left > 0 && (
            <li className="text-text-muted text-ui-sm">
              {t("sessions.moreFacts", { count: left })}
            </li>
          )}
        </ul>
      ) : (
        <p className="text-text-muted text-ui-sm">{t("sessions.noFacts")}</p>
      )}
    </article>
  );
}
