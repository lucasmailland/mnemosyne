"use client";

import { createContext, useCallback, useContext, type ReactNode } from "react";

import {
  DEFAULT_LOCALE,
  translate,
  type Locale,
  type MessageKey,
  type Messages,
  type T,
  type Vars,
} from "./core";
import { en } from "./messages/en";
import { es } from "./messages/es";

const DICTIONARIES: Record<Locale, Messages> = { "en-US": en, "es-419": es };
const LocaleContext = createContext<Locale>(DEFAULT_LOCALE);

export function I18nProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}

export function useLocale(): Locale {
  return useContext(LocaleContext);
}

export function useT(): T {
  const locale = useLocale();
  return useCallback(
    (key: MessageKey, vars?: Vars) => translate(DICTIONARIES[locale], key, vars, locale),
    [locale]
  );
}
