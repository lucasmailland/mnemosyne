import Link from "next/link";

import { KindPill } from "@/components/badges";
import { shortId } from "@/lib/short-id";

/**
 * One card of the index (facts, decisions and entities alike): the short id mark, the kind,
 * tags and a date, then the statement, struck through and faint once closed. A link when the
 * card opens a plate.
 */
export function IndexCard({
  id,
  kind,
  tags,
  date,
  statement,
  topicKey,
  description,
  closed,
  href,
  current,
  index,
}: {
  id: string;
  /** The localized kind label. */
  kind: string;
  /** Localized tags shown after the kind (a status, "Pinned", a mention count). */
  tags: string[];
  date?: string;
  statement: string;
  /** A decision's topic key, in mono under the statement. */
  topicKey?: string | null;
  /** An entity's description, clamped to two lines. */
  description?: string | null;
  closed: boolean;
  href?: string;
  current?: boolean;
  index: number;
}) {
  const box = "catalog-card bg-surface border-border block border px-4 py-3";
  const body = (
    <>
      <span className="text-text-faint text-mono-xs flex flex-wrap items-center justify-between gap-x-3 gap-y-1 font-mono">
        <span>{shortId(id)}</span>
        <span className="flex flex-wrap items-center gap-2">
          <KindPill label={kind} />
          {tags.map((tag) => (
            <span key={tag}>{tag}</span>
          ))}
          {date && <span>{date}</span>}
        </span>
      </span>
      <span
        className={`text-ui-sm mt-2 block leading-relaxed break-words ${closed ? "catalog-struck text-text-faint" : ""}`}
      >
        {statement}
      </span>
      {topicKey && (
        <span className="text-text-muted text-mono-xs mt-1 block font-mono break-words">
          {topicKey}
        </span>
      )}
      {description && (
        <span className="text-text-muted text-ui-xs mt-1 line-clamp-2 block">{description}</span>
      )}
    </>
  );
  return (
    <li className="enter" style={{ "--i": index } as React.CSSProperties}>
      {href ? (
        <Link href={href} aria-current={current ? "page" : undefined} className={box}>
          {body}
        </Link>
      ) : (
        <div className={box}>{body}</div>
      )}
    </li>
  );
}
