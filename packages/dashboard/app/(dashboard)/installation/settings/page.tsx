import { getT } from "@/lib/i18n/server";
import { installationTitle } from "@/lib/i18n/installation-title";
import { apiGet, requireSuperadmin } from "@/lib/server-api";

import { SettingsForm, type SettingsView } from "./settings-form";

export const generateMetadata = installationTitle("installation-settings");

/** Installation — Settings: invitations switch and the public base URL of links. */
export default async function SettingsPage() {
  await requireSuperadmin();
  const settings = await apiGet<SettingsView>("/instance/settings");
  const t = await getT();

  return (
    <div className="w-full">
      {settings ? (
        <SettingsForm initial={settings} />
      ) : (
        <p className="text-ui text-text-muted">{t("installation.settings.loadError")}</p>
      )}
    </div>
  );
}
