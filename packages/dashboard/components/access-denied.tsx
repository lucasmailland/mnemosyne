import type { T } from "@/lib/i18n/core";

/**
 * What an admin room shows when the API answered 403 (APP-040): one panel that says which
 * permission the page needs, instead of per-card errors telling the reader to reload a page
 * that will never load for them. The page renders nothing else, so no action is offered.
 */
export function AccessDenied({ t, scope }: { t: T; scope: string }) {
  return (
    <section
      data-testid="access-denied"
      aria-labelledby="access-denied-title"
      className="border-border bg-surface-2 border p-4 sm:p-5"
    >
      <h2 id="access-denied-title" className="font-display text-display-6 text-text">
        {t("access.title")}
      </h2>
      <p className="text-text-muted text-ui mt-1">{t("access.adminBody", { scope })}</p>
    </section>
  );
}
