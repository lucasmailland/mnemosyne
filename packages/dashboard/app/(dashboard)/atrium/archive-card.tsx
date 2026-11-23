import type { T } from "@/lib/i18n/core";

/** Shown when no memory disagrees: one line that says so. */
export function ArchiveCard({ t }: { t: T }) {
  return (
    <div data-testid="atrium-archive" className="border-border-soft mt-4 border-l-2 pl-4">
      <p className="text-text text-ui font-semibold">{t("home.archive.title")}</p>
      <p className="text-text-muted text-ui-sm mt-1 leading-snug">{t("home.archive.body")}</p>
    </div>
  );
}
