import type { T } from "@/lib/i18n/core";

export type SkeletonShape = "figures" | "list" | "search" | "sky" | "grid";

const BLOCK = "bg-surface-2 motion-safe:animate-pulse";

/** The band of key figures most rooms open with. */
function Band() {
  return (
    <div className="border-border bg-surface grid grid-cols-2 gap-6 border p-4 sm:grid-cols-4 sm:p-5">
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} className="space-y-2">
          <div className={`${BLOCK} h-3 w-20`} />
          <div className={`${BLOCK} h-8 w-24`} />
        </div>
      ))}
    </div>
  );
}

const rows = (n: number, className: string) =>
  Array.from({ length: n }, (_, i) => (
    <div key={i} className={`border-border bg-surface border p-4 ${className}`}>
      <div className={`${BLOCK} h-3 w-24`} />
      <div className={`${BLOCK} mt-3 h-4 w-full`} />
    </div>
  ));

/**
 * What a room shows while its server render waits on the API (APP-043): the room's own
 * layout in grey blocks, marked busy and announced once, politely.
 */
export function RoomSkeleton({ t, shape }: { t: T; shape: SkeletonShape }) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-live="polite"
      data-shape={shape}
      className="w-full space-y-6"
    >
      <span className="sr-only">{t("common.loadingEllipsis")}</span>
      <div aria-hidden="true" className="space-y-6">
        {shape === "sky" ? (
          <div className={`${BLOCK} h-96 w-full`} />
        ) : shape === "search" ? (
          <>
            <div className="border-border bg-surface h-12 border" />
            <div className="space-y-2">{rows(4, "")}</div>
          </>
        ) : (
          <>
            <Band />
            {shape === "figures" ? (
              <div className="grid gap-6 lg:grid-cols-2">
                {Array.from({ length: 4 }, (_, i) => (
                  <div key={i} className="border-border bg-surface h-64 border p-4" />
                ))}
              </div>
            ) : shape === "grid" ? (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{rows(6, "h-32")}</div>
            ) : (
              <div className="grid gap-2 lg:grid-cols-2">{rows(6, "")}</div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
