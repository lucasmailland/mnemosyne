"use client";

import { useState } from "react";

import { LOCALE_COOKIE, resolveLocale, type Locale } from "@/lib/i18n/core";
import { resolveTheme, THEME_COOKIE, themeAttribute } from "@/lib/theme";

import { fontVariables } from "./fonts";
import "./globals.css";

/** The only strings this page needs, inline so it pulls in no dictionary (a unit test keeps them equal to it). */
export const GLOBAL_ERROR_STRINGS: Record<Locale, Record<string, string>> = {
  "en-US": {
    errorName: "Error",
    errorTitle: "Something was lost on the way.",
    errorBody: "The page could not be shown. Try again, or go back to the start.",
    reference: "Reference",
    retry: "Try again",
    toDashboard: "Go to the dashboard",
  },
  "es-419": {
    errorName: "Error",
    errorTitle: "Algo se perdió en el camino.",
    errorBody: "No se pudo mostrar la página. Inténtalo de nuevo o vuelve al inicio.",
    reference: "Referencia",
    retry: "Inténtalo de nuevo",
    toDashboard: "Ir al panel",
  },
};

const cookie = (name: string) =>
  typeof document === "undefined"
    ? undefined
    : document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`))?.[1];

/**
 * Last resort: the root layout itself failed, so this draws its own <html> and has
 * no provider. It reads the locale and theme cookies when it first renders, shows no image
 * and needs nothing but the dictionaries and the tokens.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // Read synchronously so the first client paint is already in the right language and theme.
  const [locale] = useState<Locale>(() =>
    resolveLocale(
      cookie(LOCALE_COOKIE),
      typeof navigator === "undefined" ? null : navigator.languages.join(",")
    )
  );
  const [theme] = useState(() => themeAttribute(resolveTheme(cookie(THEME_COOKIE))));
  const t = (key: string) => GLOBAL_ERROR_STRINGS[locale][key];

  return (
    <html lang={locale} data-theme={theme} className={fontVariables} suppressHydrationWarning>
      <head>
        <title>{`${t("errorName")} · Mnemosyne`}</title>
      </head>
      <body className="min-h-screen bg-base font-sans text-text antialiased">
        <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center p-6">
          <p className="eyebrow" aria-hidden="true">
            {t("errorName")}
          </p>
          <h1 className="font-display text-display-4 mt-2 leading-tight font-normal break-words lg:text-display-3">
            <span className="sr-only">{t("errorName")} — </span>
            {t("errorTitle")}
          </h1>
          <p className="text-ui text-text-muted mt-3">{t("errorBody")}</p>
          {error.digest && (
            <p className="text-text-faint text-mono-sm mt-3">
              {t("reference")}: <span className="font-mono">{error.digest}</span>
            </p>
          )}
          <div className="mt-6 flex flex-wrap items-center gap-4">
            <button
              type="button"
              onClick={reset}
              className="border-border bg-surface text-text text-ui-sm min-h-11 border px-4"
            >
              {t("retry")}
            </button>
            {/* A plain link: with the root layout gone there is no client router to trust. */}
            <a
              href="/dashboard"
              className="text-ui-sm text-accent min-h-11 content-center underline underline-offset-4"
            >
              {t("toDashboard")}
            </a>
          </div>
        </main>
      </body>
    </html>
  );
}
