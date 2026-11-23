import { useId } from "react";

import { HatchPattern } from "@/components/hatch";
import { formatDate, type Locale, type T } from "@/lib/i18n/core";

const TICK_GAP = 22; // percent of the track between two printed month labels

interface Tick {
  pct: number;
  date: Date;
}

/**
 * Month labels from the earliest date to now: the first at 0, then month starts, thinned so labels
 * never touch, each other or the "now" label at the right end (it gets the same gap).
 */
export function monthTicks(from: Date, now: Date): Tick[] {
  const span = Math.max(now.getTime() - from.getTime(), 1);
  const ticks: Tick[] = [{ pct: 0, date: from }];
  let last = 0;
  for (
    let d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));
    d < now;
    d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))
  ) {
    const pct = ((d.getTime() - from.getTime()) / span) * 100;
    if (pct - last >= TICK_GAP && 100 - pct >= TICK_GAP) {
      ticks.push({ pct, date: d });
      last = pct;
    }
  }
  return ticks;
}

function Track({
  testId,
  label,
  from,
  to,
  domain,
  hatch,
  t,
  locale,
}: {
  testId: string;
  label: string;
  from: Date;
  to: Date | null;
  domain: { start: number; span: number };
  hatch: string;
  t: T;
  locale: Locale;
}) {
  if (Number.isNaN(from.getTime()) || (to && Number.isNaN(to.getTime())))
    return (
      <div data-testid={testId} data-state="unknown" className="mb-4">
        <p className="eyebrow">{label}</p>
        <p className="text-text-muted text-mono-sm mt-2 font-mono">—</p>
      </div>
    );
  const x = ((from.getTime() - domain.start) / domain.span) * 100;
  const end =
    (((to ? to.getTime() : domain.start + domain.span) - domain.start) / domain.span) * 100;
  const width = Math.max(end - x, 1.5);
  const closed = to !== null;
  const start = formatDate(locale, from, "short");
  return (
    <div data-testid={testId} data-state={closed ? "closed" : "open"} className="mb-4">
      <p className="eyebrow">{label}</p>
      <svg aria-hidden="true" width="100%" height="22" className="border-border-soft mt-2 border-y">
        <rect
          x={`${x}%`}
          y="3"
          width={`${width}%`}
          height="16"
          fill={closed ? `url(#${hatch})` : "var(--color-accent)"}
        />
      </svg>
      <p className="text-text-muted text-mono-sm mt-2 font-mono break-words">
        {to
          ? t("browser.clocks.range", { from: start, to: formatDate(locale, to, "short") })
          : t("browser.clocks.open", { from: start })}
      </p>
    </div>
  );
}

/**
 * The two clocks: when the memory was true in the world, and when Mnemosyne knew it.
 * A span that has ended is hatched, the current one is solid. The dates are printed under
 * each track, which is also the text equivalent of the drawing.
 */
export function Clocks({
  t,
  locale,
  validFrom,
  validTo,
  createdAt,
  supersededAt,
  now,
}: {
  t: T;
  locale: Locale;
  validFrom: string;
  validTo: string | null;
  createdAt: string;
  supersededAt: string | null;
  now: Date;
}) {
  const hatch = useId();
  const world = { from: new Date(validFrom), to: validTo ? new Date(validTo) : null };
  const known = { from: new Date(createdAt), to: supersededAt ? new Date(supersededAt) : null };
  const dates = [world.from, known.from, world.to, known.to].filter((d): d is Date => !!d);
  const valid = dates.filter((d) => !Number.isNaN(d.getTime()));
  const earliest = new Date(Math.min(...(valid.length ? valid : [now]).map((d) => d.getTime())));
  const latest = new Date(Math.max(now.getTime(), ...valid.map((d) => d.getTime())));
  const domain = {
    start: earliest.getTime(),
    span: Math.max(latest.getTime() - earliest.getTime(), 1),
  };
  const ticks = monthTicks(earliest, latest);
  return (
    <section aria-labelledby="catalog-clocks" className="mt-6">
      <h3 id="catalog-clocks" className="eyebrow mb-3">
        {t("browser.clocks.title")}
      </h3>
      <svg width="0" height="0" aria-hidden="true" className="absolute">
        <defs>
          <HatchPattern id={hatch} />
        </defs>
      </svg>
      <Track
        testId="clock-world"
        label={t("browser.clocks.world")}
        {...world}
        domain={domain}
        hatch={hatch}
        t={t}
        locale={locale}
      />
      <Track
        testId="clock-known"
        label={t("browser.clocks.known")}
        {...known}
        domain={domain}
        hatch={hatch}
        t={t}
        locale={locale}
      />
      <div aria-hidden="true" className="text-text-faint text-mono-xs relative h-4 font-mono">
        {ticks.map((k) => (
          <span
            key={k.pct}
            className="absolute whitespace-nowrap"
            style={{
              left: `${k.pct}%`,
              transform: k.pct === 0 ? "none" : "translateX(-50%)",
            }}
          >
            {formatDate(locale, k.date, "month")}
          </span>
        ))}
        <span className="absolute right-0 uppercase">{t("browser.clocks.now")}</span>
      </div>
    </section>
  );
}
