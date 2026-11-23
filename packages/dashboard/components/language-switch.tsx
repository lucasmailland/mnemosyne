"use client";

import { useRouter } from "next/navigation";

import { LOCALE_COOKIE, LOCALES, type Locale } from "@/lib/i18n/core";
import { useLocale, useT } from "@/lib/i18n/client";
import { setPreference } from "@/lib/preferences";

// Each language is named in itself, so these are not translated.
const NAMES: Record<Locale, string> = { "en-US": "English", "es-419": "Español" };

export function LanguageSwitch() {
  const router = useRouter();
  const locale = useLocale();
  const t = useT();
  return (
    <div role="group" aria-label={t("preferences.language")} className="flex gap-2">
      {LOCALES.map((l) => (
        <button
          key={l}
          type="button"
          lang={l}
          aria-pressed={l === locale}
          onClick={() => {
            setPreference(LOCALE_COOKIE, l);
            router.refresh();
          }}
          className="px-2 py-1 text-xs text-text-muted hover:text-text aria-pressed:font-semibold aria-pressed:text-accent focus-visible:outline-2 focus-visible:outline-accent"
        >
          {NAMES[l]}
        </button>
      ))}
    </div>
  );
}
