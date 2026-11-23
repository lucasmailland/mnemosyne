import { LOCALE_COOKIE, LOCALES } from "@/lib/i18n/core";
import { THEME_COOKIE, THEMES } from "@/lib/theme";

const ALLOWED: Record<string, readonly string[]> = {
  [LOCALE_COOKIE]: LOCALES,
  [THEME_COOKIE]: THEMES,
};

/** Browser only. Anything outside the allowed set is ignored. */
export function setPreference(
  name: typeof LOCALE_COOKIE | typeof THEME_COOKIE,
  value: string
): void {
  if (!ALLOWED[name]?.includes(value)) return;
  document.cookie = `${name}=${value}; Path=/dashboard; Max-Age=31536000; SameSite=Lax`;
}
