import Link from "next/link";

import { getLocale, getT, roomTitle } from "@/lib/i18n/server";
import { apiGet, getSession } from "@/lib/server-api";

import { WorkspaceFigures } from "./figures";
import { WorkspacesView, type MyWorkspaces } from "./workspaces-view";

export const generateMetadata = roomTitle("workspaces");

/**
 * Workspaces: the ones the signed-in person belongs to, a way to switch
 * between them, and a form to create a team workspace they own (up to the
 * installation's per-user limit; superadmins have none).
 */
export default async function WorkspacesPage() {
  const t = await getT();
  const locale = await getLocale();
  const [session, data] = await Promise.all([getSession(), apiGet<MyWorkspaces>("/my-workspaces")]);

  return (
    <div className="w-full">
      {session?.authMethod !== "password" || !data ? (
        <p className="text-ui text-text-muted">{t("workspaces.signInRequired")}</p>
      ) : (
        <>
          <WorkspaceFigures t={t} locale={locale} data={data} />
          <WorkspacesView
            data={data}
            listInfo={
              session.isSuperadmin ? (
                <>
                  {t("workspaces.superadminLead")}{" "}
                  <Link href="/installation/workspaces" className="text-accent underline">
                    {t("nav.installationWorkspaces")}
                  </Link>
                  .
                </>
              ) : undefined
            }
          />
        </>
      )}
    </div>
  );
}
