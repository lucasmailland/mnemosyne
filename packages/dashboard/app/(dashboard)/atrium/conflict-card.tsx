"use client";

import Link from "next/link";
import { useState } from "react";

import { ConfirmDialog } from "@/components/keeper";
import { useLocale, useT } from "@/lib/i18n/client";
import { formatDate, formatNumber } from "@/lib/i18n/core";
import { errorMessage } from "@/lib/i18n/errors";

import { useNeeds } from "./needs";
import type { ConflictPair } from "./types";

type Action = "supersede_a" | "supersede_b" | "keep_both";

/**
 * One open conflict of the queue. Older statement on the left (hatched), newer on
 * the right. Writers can keep the newer (the older fact is superseded) or keep
 * both, each after a confirmation that says what happens: the server has no
 * reverse for a resolution, so the dialog says it cannot be undone (APP-044).
 * Everyone can follow the lineage.
 */
export function ConflictCard({ pair, canWrite }: { pair: ConflictPair; canWrite: boolean }) {
  const t = useT();
  const locale = useLocale();
  const { refreshing, resolved } = useNeeds();
  const [posting, setPosting] = useState(false);
  const busy = posting || refreshing;
  const [error, setError] = useState<string | null>(null);
  const [asked, setAsked] = useState<Action | null>(null);

  const aIsOlder = pair.factA.validFrom <= pair.factB.validFrom;
  const [older, newer] = aIsOlder ? [pair.factA, pair.factB] : [pair.factB, pair.factA];

  async function resolve(action: Action) {
    setPosting(true);
    setError(null);
    try {
      const res = await fetch(
        `/dashboard/api/conflicts/${encodeURIComponent(pair.relationId)}/resolve`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action }),
        }
      );
      if (res.ok)
        resolved(t(action === "keep_both" ? "home.needs.keptBoth" : "home.needs.keptNewer"));
      else setError(errorMessage(t, { status: res.status }));
    } catch {
      setError(errorMessage(t, { code: "network" }));
    } finally {
      setPosting(false);
      setAsked(null);
    }
  }

  const button =
    "min-h-11 border px-4 text-ui-sm disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
  const supersede: Action = aIsOlder ? "supersede_a" : "supersede_b";
  return (
    <div className="border-border bg-surface border">
      <div className="flex items-baseline justify-between gap-3 px-4 pt-4 pb-3">
        <p className="text-text text-ui font-semibold">{t("home.needs.pairTitle")}</p>
        {pair.confidence != null && (
          <span className="text-text-faint font-mono text-mono-xs">
            {t("home.needs.confidence", {
              value: formatNumber(locale, pair.confidence, 2),
            })}
          </span>
        )}
      </div>
      <div className="border-border-soft grid border-t sm:grid-cols-2">
        <div className="atrium-hatch text-text-muted text-ui-sm px-4 py-3 leading-snug">
          <p>{older.statement}</p>
          <p className="text-text-faint mt-2 font-mono text-mono-xs">
            {t("home.needs.older")} · {formatDate(locale, older.validFrom, "short")}
          </p>
        </div>
        <div className="border-border-soft text-ui-sm border-t px-4 py-3 leading-snug sm:border-t-0 sm:border-l">
          <p>{newer.statement}</p>
          <p className="text-text-faint mt-2 font-mono text-mono-xs">
            {t("home.needs.newer")} · {formatDate(locale, newer.validFrom, "short")}
          </p>
        </div>
      </div>
      <div className="border-border-soft flex flex-wrap gap-2 border-t px-4 py-3">
        {canWrite && (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => setAsked(supersede)}
              className={`${button} border-accent bg-accent text-on-accent`}
            >
              {t("home.needs.keepNewer")}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setAsked("keep_both")}
              className={`${button} border-border text-text-muted`}
            >
              {t("home.needs.keepBoth")}
            </button>
          </>
        )}
        <Link
          href={`/browser?open=${encodeURIComponent(newer.id)}`}
          className={`${button} border-border text-text-muted inline-flex items-center`}
        >
          {t("home.needs.showLineage")}
        </Link>
      </div>
      <ConfirmDialog
        open={asked !== null}
        title={t(
          asked === "keep_both" ? "home.needs.confirmBothTitle" : "home.needs.confirmNewerTitle"
        )}
        body={
          <>
            <p>
              {asked === "keep_both"
                ? t("home.needs.confirmBothBody")
                : t("home.needs.confirmNewerBody", { older: older.statement })}
            </p>
            <p className="mt-2">{t("home.needs.noUndo")}</p>
          </>
        }
        confirmLabel={t("home.needs.confirm")}
        busy={posting}
        onConfirm={() => asked && resolve(asked)}
        onClose={() => setAsked(null)}
      />
      {error && (
        <p role="alert" className="text-red text-ui-sm px-4 pb-3">
          {error}
        </p>
      )}
    </div>
  );
}
