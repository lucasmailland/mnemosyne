import { getLocale, getT } from "@/lib/i18n/server";
import { installationTitle } from "@/lib/i18n/installation-title";
import { apiGet, requireSuperadmin } from "@/lib/server-api";

import { UserFigures } from "../figures";
import { UsersView, type InstanceUser } from "./users-view";

export const generateMetadata = installationTitle("installation-users");

/**
 * Installation — Users: every account of the installation, with the actions a
 * superadmin has on them (accounts stage A). Superadmins only; anyone else
 * gets the 404 of an unknown address.
 */
export default async function UsersPage() {
  const session = await requireSuperadmin();
  const data = await apiGet<{ users: InstanceUser[] }>("/instance/users");
  const t = await getT();
  const locale = await getLocale();

  return (
    <div className="w-full">
      {data ? (
        <>
          <UserFigures t={t} locale={locale} users={data.users} />
          <UsersView users={data.users} viewerId={session.userId ?? null} />
        </>
      ) : (
        <p className="text-ui text-text-muted">{t("installation.users.loadError")}</p>
      )}
    </div>
  );
}
