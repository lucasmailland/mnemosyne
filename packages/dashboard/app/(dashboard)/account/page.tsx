import { cookies } from "next/headers";

import { getT, getLocale, roomTitle } from "@/lib/i18n/server";
import { Section } from "@/components/keeper";
import { apiGet, getSession } from "@/lib/server-api";
import { resolveTheme, THEME_COOKIE } from "@/lib/theme";
import { AccountFigures, parseOwnActivity } from "./figures";
import { PasswordForm } from "./password-form";
import { PreferencesForm } from "./preferences-form";

export const generateMetadata = roomTitle("account");

export default async function AccountPage() {
  const [session, rawActivity, mine] = await Promise.all([
    getSession(),
    apiGet<unknown>("/me/activity?days=30"),
    apiGet<{ workspaces?: Array<{ isPersonal?: boolean; factsLive?: number | null }> }>(
      "/my-workspaces"
    ),
  ]);
  const personal = mine?.workspaces?.find((w) => w.isPersonal)?.factsLive;
  const t = await getT();
  const locale = await getLocale();
  let themeValue: string | undefined;
  try {
    themeValue = (await cookies()).get(THEME_COOKIE)?.value;
  } catch {
    // No request scope (unit tests): fall back to light.
  }
  return (
    <div className="w-full">
      <AccountFigures
        t={t}
        locale={locale}
        session={session}
        activity={parseOwnActivity(rawActivity)}
        personal={typeof personal === "number" ? personal : null}
      />
      <Section id="preferences" title={t("account.preferencesTitle")}>
        <PreferencesForm locale={locale} theme={resolveTheme(themeValue)} />
      </Section>
      <Section title={t("account.passwordTitle")}>
        {session?.authMethod === "password" ? (
          <PasswordForm />
        ) : (
          <p className="text-ui text-text-muted">{t("account.passwordUnavailable")}</p>
        )}
      </Section>
    </div>
  );
}
