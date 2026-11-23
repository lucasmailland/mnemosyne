import { AccessDenied } from "@/components/access-denied";
import { RecordRow, Records, Section, StatusTag } from "@/components/keeper";
import { TagOverflow } from "@/components/ui/tag-overflow";
import { formatDate } from "@/lib/i18n/core";
import { getLocale, getT, roomTitle } from "@/lib/i18n/server";
import { apiRead } from "@/lib/server-api";

import { KeyFigures } from "./figures";
import { CreateKeyForm, KeyActions } from "./key-actions";

/**
 * Admin — API Key Management (spec §4.7): list, create (show-once), rotate
 * (show-once, the old key keeps working for the grace period), revoke.
 * GET /admin/keys lists active keys only: a revoked key leaves the list.
 */

export interface ApiKeyListItem {
  id: string;
  label: string;
  name: string;
  prefix: string;
  scopes: string[];
  plan: string;
  ipAllowlist: string[];
  expiresAt: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  /** When the key was rotated; it keeps working until `sunsetAt`. */
  deprecatedAt: string | null;
  sunsetAt: string | null;
  /** The key's own sensitivity ceiling; null: the installation's. */
  maxSensitivity?: string | null;
}

export const generateMetadata = roomTitle("keys");

export default async function KeysPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | undefined>>;
}) {
  // ⌘K "New API key" lands here with ?create=1 and the form already open.
  const createOpen = (await searchParams)?.create === "1";
  const t = await getT();
  const locale = await getLocale();
  // GET /admin/keys answers { keys: [...] }. This page used to read `items`,
  // so it never listed a key and said it could not load them.
  const res = await apiRead<{ keys: ApiKeyListItem[] }>("/admin/keys");
  // A 403 is not a load failure: the reader lacks the permission, and reloading will not help.
  if (res.status === 403) return <AccessDenied t={t} scope="admin:keys" />;
  const items = Array.isArray(res.data?.keys) ? res.data.keys : null;

  return (
    <div className="w-full">
      <KeyFigures t={t} keys={items} />
      {/* ?create=1 opens it; a palette pick on this page opens it too, without a remount that
          would drop a show-once key (CreateKeyForm listens for the pick). */}
      <CreateKeyForm defaultOpen={createOpen} />

      <Section title={t("keys.listLabel")}>
        {items === null ? (
          <p className="text-ui text-text-muted">
            {res.timedOut ? t("common.timeout") : t("keys.loadError")}
          </p>
        ) : items.length === 0 ? (
          <p className="border border-border bg-surface px-4 py-6 text-center text-ui text-text-muted">
            {t("keys.empty")}
          </p>
        ) : (
          <Records label={t("keys.listLabel")}>
            {items.map((k) => (
              <RecordRow key={k.id}>
                <KeyActions keyId={k.id} label={k.label || k.name} rotated={!!k.deprecatedAt}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-ui font-medium">{k.label || k.name}</span>
                    {k.deprecatedAt && (
                      <StatusTag tone="warn" caseless>
                        {t("keys.rotated", {
                          time: k.sunsetAt
                            ? formatDate(locale, k.sunsetAt, "datetime")
                            : t("keys.graceEnd"),
                        })}
                      </StatusTag>
                    )}
                    <span className="text-ui-xs capitalize text-text-muted">{k.plan}</span>
                  </div>
                  <div className="mt-1 font-mono text-mono text-text-muted">{k.prefix}…</div>
                  {/* The first permissions, and +N for the rest in a popover. */}
                  <div className="mt-2">
                    <TagOverflow
                      label={t("keys.scopesOf", { label: k.label || k.name })}
                      tags={k.scopes}
                      mono
                    />
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-ui-xs text-text-muted">
                    <span>
                      {t("keys.created", { date: formatDate(locale, k.createdAt, "short") })}
                    </span>
                    <span>
                      {t("keys.lastUsed", {
                        date: k.lastUsedAt
                          ? formatDate(locale, k.lastUsedAt, "short")
                          : t("keys.never"),
                      })}
                    </span>
                    <span>
                      {t("keys.expires", {
                        date: k.expiresAt
                          ? formatDate(locale, k.expiresAt, "short")
                          : t("keys.never"),
                      })}
                    </span>
                  </div>
                </KeyActions>
              </RecordRow>
            ))}
          </Records>
        )}
      </Section>
    </div>
  );
}
