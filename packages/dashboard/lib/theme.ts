export const THEMES = ["light", "dark", "system"] as const;
export type Theme = (typeof THEMES)[number];

export const THEME_COOKIE = "mnemo_theme";

/**
 * Absent or invalid values follow the reader's OS (`system`): someone who never chose a
 * theme gets the one their system asks for, not light (APP-058).
 */
export function resolveTheme(value: string | undefined): Theme {
  return value === "dark" || value === "light" ? value : "system";
}

/** `system` has no attribute so the prefers-color-scheme media query decides. */
export function themeAttribute(theme: Theme): "light" | "dark" | undefined {
  return theme === "system" ? undefined : theme;
}
