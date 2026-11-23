import { getLocale, getT } from "@/lib/i18n/server";
import { installationTitle } from "@/lib/i18n/installation-title";
import { apiGet, requireSuperadmin } from "@/lib/server-api";

import { InstanceWorkspaceFigures } from "../figures";
import { WorkspacesView, type InstanceWorkspace } from "./workspaces-view";

export const generateMetadata = installationTitle("installation-workspaces");

/**
 * Installation — Workspaces: every workspace, its owners and members, and
 * "Open" to look inside one. Superadmins only.
 */
export default async function WorkspacesPage() {
  await requireSuperadmin();
  const data = await apiGet<{ workspaces: InstanceWorkspace[] }>("/instance/workspaces");

  const t = await getT();
  const locale = await getLocale();
  return (
    <div className="w-full">
      {data ? (
        <>
          <InstanceWorkspaceFigures t={t} locale={locale} workspaces={data.workspaces} />
          <WorkspacesView workspaces={data.workspaces} info={t("lead.installationWorkspaces")} />
        </>
      ) : (
        <p className="text-ui text-text-muted">{t("installation.workspaces.loadError")}</p>
      )}
    </div>
  );
}
