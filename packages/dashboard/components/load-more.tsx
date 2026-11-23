import Link from "next/link";

/** The quiet secondary button of a list room (Next page, Load more, Search). */
export const LIST_BUTTON =
  "border-control-border text-text-muted hover:border-accent hover:text-text inline-flex min-h-11 items-center border px-4 text-ui-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

/** A link that asks the server for more of a list. */
export function LoadMore({ href, label }: { href: string; label: string }) {
  return (
    <div className="mt-4 text-center">
      <Link href={href} className={LIST_BUTTON}>
        {label}
      </Link>
    </div>
  );
}

/** Said under a list that stopped at the route's cap, so a cut is never silent (APP-043). */
export function CapNote({ children }: { children: React.ReactNode }) {
  return <p className="text-text-muted text-ui-sm mt-4 text-center">{children}</p>;
}
