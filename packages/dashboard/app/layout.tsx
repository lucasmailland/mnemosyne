import type { Metadata } from "next";
import { cookies } from "next/headers";

import { I18nProvider } from "@/lib/i18n/client";
import { getLocale } from "@/lib/i18n/server";
import { resolveTheme, THEME_COOKIE, themeAttribute } from "@/lib/theme";

import { fontVariables } from "./fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: "Mnemosyne — Dashboard",
  description: "Observability, configuration, and interactive recall for Mnemosyne memory.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  let themeValue: string | undefined;
  try {
    themeValue = (await cookies()).get(THEME_COOKIE)?.value;
  } catch {
    // No request scope (unit tests): follow the OS, as with no cookie.
  }
  const locale = await getLocale();
  return (
    <html
      lang={locale}
      data-theme={themeAttribute(resolveTheme(themeValue))}
      className={fontVariables}
    >
      <body className="min-h-screen bg-base font-sans text-text antialiased">
        <I18nProvider locale={locale}>{children}</I18nProvider>
      </body>
    </html>
  );
}
