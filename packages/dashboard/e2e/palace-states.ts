import type { Page } from "@playwright/test";
import { translate, type Locale } from "../lib/i18n/core";
import { en } from "../lib/i18n/messages/en";
import { es } from "../lib/i18n/messages/es";
import { state } from "./support";

/**
 * The palace rooms in the states that only exist with data: an opened memory,
 * an opened niche, a recall that has run, a selected star. The gate specs
 * (layout, a11y) measure these next to the bare rooms in `ROOMS`.
 */
export interface PalaceState {
  /** Path under /dashboard, query included. */
  path: string;
  /** Runs after the page has loaded, before it is measured. */
  prepare?: (page: Page) => Promise<void>;
}

/** Named statically: the specs list their tests at load time, before global-setup has written the seed. */
export const PALACE_STATES = ["browser", "sessions", "recall", "relations"] as const;
export type PalaceStateId = (typeof PALACE_STATES)[number];

export function palaceState(id: PalaceStateId, locale: Locale): PalaceState {
  const messages = locale === "es-419" ? es : en;
  const t = (key: Parameters<typeof translate>[1]) => translate(messages, key, undefined, locale);
  const { supersededFactId, episodeId, recallQuery } = state().palace;
  switch (id) {
    case "browser":
      return { path: `/browser?open=${supersededFactId}` };
    case "sessions":
      return { path: `/sessions?open=${episodeId}` };
    case "recall":
      return {
        path: "/recall",
        prepare: async (page) => {
          await page.getByRole("textbox", { name: t("recall.placeholder") }).fill(recallQuery);
          await page.getByRole("button", { name: t("recall.run"), exact: true }).click();
          await page.getByTestId("lethe-hit").first().waitFor();
        },
      };
    case "relations":
      return {
        path: "/relations",
        prepare: async (page) => {
          const stop = page.locator('[data-testid="sky-graph"] button[tabindex="0"]');
          await stop.focus();
          await page.keyboard.press("Enter");
          await page.getByTestId("sky-card").waitFor();
        },
      };
  }
}
