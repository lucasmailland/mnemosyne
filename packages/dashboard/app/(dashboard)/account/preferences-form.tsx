"use client";

import { useRouter } from "next/navigation";
import { startTransition, useOptimistic } from "react";

import { Segmented } from "@/components/ui/segmented";
import { useT } from "@/lib/i18n/client";
import { LOCALE_COOKIE, LOCALES, type Locale } from "@/lib/i18n/core";
import { setPreference } from "@/lib/preferences";
import { THEME_COOKIE, THEMES, type Theme } from "@/lib/theme";

/**
 * The props (read from the cookies on the server) are the source of truth. A choice shows at
 * once through useOptimistic; router.refresh() then brings the new props, which replace it.
 */
export function PreferencesForm({ locale, theme }: { locale: Locale; theme: Theme }) {
  const router = useRouter();
  const t = useT();
  const [currentTheme, setTheme] = useOptimistic(theme);
  const [currentLocale, setLocale] = useOptimistic(locale);
  const languageLabel: Record<Locale, string> = {
    "en-US": t("preferences.english"),
    "es-419": t("preferences.spanish"),
  };
  return (
    <div className="flex flex-col gap-6">
      <Segmented
        label={t("preferences.language")}
        stacked
        name="language"
        options={LOCALES.map((value) => ({ value, label: languageLabel[value] }))}
        value={currentLocale}
        onChange={(value) => {
          setPreference(LOCALE_COOKIE, value);
          // The transition keeps the choice shown until refresh() brings the new props.
          startTransition(() => {
            setLocale(value as Locale);
            router.refresh();
          });
        }}
      />
      <Segmented
        label={t("preferences.theme")}
        stacked
        name="theme"
        options={THEMES.map((value) => ({ value, label: t(`preferences.${value}`) }))}
        value={currentTheme}
        onChange={(value) => {
          setPreference(THEME_COOKIE, value);
          // The transition keeps the choice shown until refresh() brings the new props.
          startTransition(() => {
            setTheme(value as Theme);
            router.refresh();
          });
        }}
      />
    </div>
  );
}
