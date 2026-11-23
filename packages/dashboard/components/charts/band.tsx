import type { ReactNode } from "react";

// Static class names, so Tailwind sees each one.
const COLS = {
  3: "sm:grid-cols-3",
  4: "sm:grid-cols-4",
  5: "sm:grid-cols-3 xl:grid-cols-5",
} as const;

/**
 * A room's band of key figures: one bordered box of 3 to 5 stat tiles, two across on a phone.
 * The heading is for assistive technology only.
 */
export function Band({
  title,
  cols,
  children,
}: {
  title: string;
  cols: keyof typeof COLS;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} data-testid="metrics-band">
      <div
        className={`border-border bg-surface grid grid-cols-2 gap-x-6 gap-y-6 border p-4 sm:p-5 ${COLS[cols]}`}
      >
        {children}
      </div>
    </section>
  );
}
