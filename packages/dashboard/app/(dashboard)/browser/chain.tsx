import Link from "next/link";

import { shortId } from "@/lib/short-id";
import type { T } from "@/lib/i18n/core";

export interface ChainFact {
  id: string;
  statement: string | null;
}

function Node({
  label,
  current,
  children,
}: {
  label: string;
  current?: boolean;
  children: React.ReactNode;
}) {
  return (
    <li
      className={`catalog-node bg-surface text-ui-sm border px-3 py-2 ${current ? "border-accent" : "border-border"}`}
    >
      <b className="eyebrow block font-medium">{label}</b>
      {children}
    </li>
  );
}

const FactLink = ({ f }: { f: ChainFact }) => (
  <Link href={`/browser?open=${encodeURIComponent(f.id)}`} className="atrium-link break-words">
    <span className="text-mono-sm font-mono">{shortId(f.id)}</span>
    {f.statement && <span className="ml-2">{f.statement}</span>}
  </Link>
);

/** Session → episode → this memory → what it supersedes / what superseded it. Missing links are left out. */
export function Chain({
  t,
  sessionId,
  episode,
  self,
  supersedes,
  supersededBy,
}: {
  t: T;
  sessionId: string | null;
  episode: { id: string; title: string | null } | null;
  self: string;
  supersedes: ChainFact[];
  supersededBy: ChainFact | null;
}) {
  return (
    <section aria-labelledby="catalog-chain-title" className="mt-6">
      <h3 id="catalog-chain-title" className="eyebrow mb-3">
        {t("browser.chain.title")}
      </h3>
      <ol
        data-testid="catalog-chain"
        className="catalog-chain flex flex-col sm:flex-row sm:flex-wrap"
      >
        {sessionId && (
          <Node label={t("browser.chain.session")}>
            <span className="text-mono-sm font-mono">{shortId(sessionId)}</span>
          </Node>
        )}
        {episode && (
          <Node label={t("browser.chain.episode")}>
            <Link
              href={`/sessions?open=${encodeURIComponent(episode.id)}`}
              className="atrium-link break-words"
            >
              {episode.title ?? (
                <span className="text-mono-sm font-mono">{shortId(episode.id)}</span>
              )}
            </Link>
          </Node>
        )}
        <Node label={t("browser.chain.thisMemory")} current>
          <span className="text-mono-sm font-mono">{shortId(self)}</span>
        </Node>
        {supersedes.length > 0 && (
          <Node label={t("browser.chain.supersedes")}>
            <ul className="space-y-1">
              {supersedes.map((f) => (
                <li key={f.id}>
                  <FactLink f={f} />
                </li>
              ))}
            </ul>
          </Node>
        )}
        {supersededBy && (
          <Node label={t("browser.chain.supersededBy")}>
            <FactLink f={supersededBy} />
          </Node>
        )}
      </ol>
    </section>
  );
}
