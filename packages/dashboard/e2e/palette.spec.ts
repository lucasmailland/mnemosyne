import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { translate, type Locale, type MessageKey, type Vars } from "../lib/i18n/core";
import { en } from "../lib/i18n/messages/en";
import { es } from "../lib/i18n/messages/es";
import { adminStorageState, paletteKey } from "./support";

/**
 * The ⌘K palette in a real browser, in both languages: it opens from Home and from a keeper
 * page, typing searches facts without ever calling recall (only ⌘↵ does, and it lands on
 * Recall with the pipeline strip, exactly one metered call), Escape hands focus back to whatever
 * opened it (the opener is inert while the modal is open, which jsdom cannot show), the arrows
 * keep the active option in view, a pick from the phone drawer closes the drawer, and the result
 * count is announced in a live region. The seeded fact is the one palace.spec uses (seed.ts).
 */
const MESSAGES = { "en-US": en, "es-419": es } as const;
// A word only the current billing-office fact carries.
const WORD = "Porto";

let storage: Awaited<ReturnType<typeof adminStorageState>>;

test.beforeAll(async ({ browser }, testInfo) => {
  storage = await adminStorageState(browser, testInfo.project.use.baseURL!);
});

async function open(browser: Browser, baseURL: string, locale: Locale): Promise<BrowserContext> {
  const context = await browser.newContext({ baseURL, storageState: storage });
  await context.addCookies([
    { name: "mnemo_locale", value: locale, domain: "localhost", path: "/dashboard" },
    { name: "mnemo_theme", value: "light", domain: "localhost", path: "/dashboard" },
  ]);
  return context;
}

for (const locale of ["en-US", "es-419"] as const) {
  test.describe(`the palette, ${locale}`, () => {
    const t = (key: MessageKey, vars?: Vars) => translate(MESSAGES[locale], key, vars, locale);
    let context: BrowserContext;
    let page: Page;
    let requests: string[];

    test.beforeAll(async ({ browser }, testInfo) => {
      context = await open(browser, testInfo.project.use.baseURL!, locale);
      page = await context.newPage();
      requests = [];
      page.on("request", (r) => requests.push(new URL(r.url()).pathname));
    });
    test.afterAll(async () => {
      await context.close();
    });

    const dialog = () => page.getByRole("dialog", { name: t("palette.title") });
    const input = () => dialog().getByRole("combobox");
    const trigger = () => page.getByRole("button", { name: t("palette.trigger") });
    const recallCalls = () => requests.filter((p) => p.startsWith("/dashboard/api/recall"));

    for (const [name, path] of [
      ["Home", "/dashboard"],
      ["a keeper page", "/dashboard/admin/keys"],
    ] as const) {
      test(`⌘K opens from ${name} and Escape closes it`, async () => {
        await page.goto(path);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        await expect(dialog()).toHaveCount(0);
        await page.keyboard.press(await paletteKey(page, "k"));
        await expect(dialog()).toBeVisible();
        await expect(input()).toBeFocused();
        await page.keyboard.press("Escape");
        await expect(dialog()).toHaveCount(0);
      });
    }

    test("typing shows the seeded fact and sends no recall until ⌘↵, which lands on Recall", async () => {
      await page.goto("/dashboard/admin/keys");
      requests.length = 0;
      await page.keyboard.press(await paletteKey(page, "k"));
      // Key by key, as a person types: every keystroke is a chance to send a recall.
      await input().pressSequentially(WORD);

      const fact = dialog()
        .getByRole("option", { name: new RegExp(WORD) })
        .first();
      await expect(fact).toBeVisible();
      await expect(fact).toContainText(t("palette.kindFact"));
      // The search ran (facts and entities), recall did not.
      expect(requests.some((p) => p.startsWith("/dashboard/api/facts"))).toBe(true);
      expect(recallCalls()).toEqual([]);

      await page.keyboard.press(await paletteKey(page, "Enter"));
      await expect(page).toHaveURL(/\/dashboard\/recall\?q=Porto(&run=1)?$/);
      await expect(dialog()).toHaveCount(0);
      await expect(page.getByTestId("lethe-strip")).toBeVisible();
      await page.waitForLoadState("networkidle");
      // Exactly one metered call: the run, never a second one when Recall drops `run=1`.
      expect(recallCalls()).toEqual(["/dashboard/api/recall"]);
    });

    test("the arrows keep the active option in view past the bottom of the list", async () => {
      await page.goto("/dashboard");
      await page.keyboard.press(await paletteKey(page, "k"));
      const count = await dialog().getByRole("option").count();
      for (let i = 1; i < count; i++) {
        await page.keyboard.press("ArrowDown");
        const inView = await input().evaluate((box) => {
          const active = document.getElementById(box.getAttribute("aria-activedescendant") ?? "");
          const list = active?.closest('[role="listbox"]');
          if (!active || !list) return false;
          const a = active.getBoundingClientRect();
          const l = list.getBoundingClientRect();
          return a.top >= l.top - 1 && a.bottom <= l.bottom + 1;
        });
        expect(inView, `option ${i + 1} of ${count}`).toBe(true);
      }
      // It did go past the fold: the list scrolled.
      expect(
        await dialog()
          .getByRole("listbox")
          .evaluate((l) => l.scrollTop)
      ).toBeGreaterThan(0);
      // On disk too (test-results/): the list scrolled, the active option in view.
      const shot = test.info().outputPath(`palette-past-the-fold-${locale}.png`);
      await page.screenshot({ path: shot });
      await test.info().attach(`palette-past-the-fold-${locale}`, {
        path: shot,
        contentType: "image/png",
      });
      await page.keyboard.press("Escape");
    });

    test("on Recall, ⌘↵ runs the typed text once in place, with no new page", async () => {
      await page.goto("/dashboard/recall");
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      requests.length = 0;
      await page.keyboard.press(await paletteKey(page, "k"));
      await input().pressSequentially(WORD);
      await page.keyboard.press(await paletteKey(page, "Enter"));
      await expect(dialog()).toHaveCount(0);
      await expect(page.getByTestId("lethe-strip")).toBeVisible();
      await page.waitForLoadState("networkidle");
      expect(recallCalls()).toEqual(["/dashboard/api/recall"]);
      // The page ran in place (the URL only keeps q), and no token is left for a later bare link.
      await expect(page).toHaveURL(/\/dashboard\/recall(\?q=Porto)?$/);
      expect(await page.evaluate(() => sessionStorage.getItem("mnemo:palette-run"))).toBeNull();
    });

    test("on a phone, a room picked from the drawer's search bar closes the drawer; focus is on Menu", async () => {
      await page.setViewportSize({ width: 375, height: 812 });
      // Back to desktop even when an assertion fails: the later tests share this page.
      try {
        await page.goto("/dashboard");
        const menu = page.locator('button[aria-controls="dashboard-navigation"]');
        await menu.click();
        await trigger().click();
        await input().pressSequentially(t("nav.config"));
        await page.keyboard.press("Enter");
        await expect(page).toHaveURL(/\/dashboard\/config$/);
        await expect(dialog()).toHaveCount(0);
        await expect(menu).toHaveAttribute("aria-expanded", "false");
        await expect(menu).toBeFocused();
      } finally {
        await page.setViewportSize({ width: 1280, height: 720 });
      }
    });

    test("Escape returns focus to the element that opened the palette", async () => {
      await page.goto("/dashboard");
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

      // Opened with the keyboard from the sidebar's search bar.
      await trigger().focus();
      await page.keyboard.press(await paletteKey(page, "k"));
      await expect(input()).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(dialog()).toHaveCount(0);
      await expect(trigger()).toBeFocused();

      // Opened with a click on it.
      await trigger().click();
      await expect(input()).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(trigger()).toBeFocused();

      // Opened from a link on the page: focus goes back to that link.
      const link = page
        .getByRole("navigation", { name: t("nav.primary") })
        .getByRole("link")
        .nth(1);
      await link.focus();
      await page.keyboard.press(await paletteKey(page, "k"));
      await expect(input()).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(link).toBeFocused();
    });

    test("the result count is announced in a live region and follows the text", async () => {
      await page.goto("/dashboard");
      await page.keyboard.press(await paletteKey(page, "k"));
      const status = dialog().getByRole("status");
      await input().pressSequentially(WORD);
      await expect(dialog().getByRole("option").first()).toBeVisible();
      // Facts and entities arrive separately: the count is read with the list it describes.
      await expect
        .poll(async () => {
          const n = await dialog().getByRole("option").count();
          return (await status.textContent()) === t("palette.count", { count: n });
        })
        .toBe(true);

      await input().clear();
      await input().pressSequentially("zzzzqqqq");
      await expect(status).toHaveText(t("palette.empty"));
      await expect(dialog().getByRole("option")).toHaveCount(0);
      await page.keyboard.press("Escape");
    });
  });
}
