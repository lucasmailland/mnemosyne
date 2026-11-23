import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { PALACE_STATES, palaceState } from "./palace-states";
import {
  EMPTY_ROOMS,
  NOT_FOUND_FOR_A_READER,
  NOT_FOUND_UNDER_A_ROOM,
  ROOMS,
  adminStorageState,
  emptyStorageState,
  inShellNotFoundProblems,
  openPalette,
  readerStorageState,
} from "./support";

/**
 * No serious or critical WCAG 2.x A/AA violation on any page (en-US), in the
 * light theme and in the dark one; and every page has its own document title.
 * The palace rooms are audited with data, in their data states, and empty; the ⌘K palette
 * is audited open with results, over Home and over a keeper page. Lethe's in-shell not-found is
 * audited like a room twice: an unknown path under a room (admin) and an Installation page opened
 * by a reader (support.ts).
 */
let storage: string;
let emptyStorage: string;
let readerStorage: string;

test.beforeAll(async ({ browser }, testInfo) => {
  storage = await adminStorageState(browser, testInfo.project.use.baseURL!);
  emptyStorage = await emptyStorageState(browser, testInfo.project.use.baseURL!);
  readerStorage = await readerStorageState(browser, testInfo.project.use.baseURL!);
});

async function audit(page: import("@playwright/test").Page) {
  // :visible — on a not-found the room header's h1 is in the DOM under display:none.
  await page.locator("h1:visible").first().waitFor();
  const { violations } = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  return violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
}

// Reduced motion: axe samples colors mid-fade otherwise, and reports blends nobody sees.
const REDUCED = { reducedMotion: "reduce" } as const;

const cookies = (theme: "light" | "dark") => [
  { name: "mnemo_locale", value: "en-US", domain: "localhost", path: "/dashboard" },
  { name: "mnemo_theme", value: theme, domain: "localhost", path: "/dashboard" },
];

for (const theme of ["light", "dark"] as const) {
  test(`/login has no serious accessibility violation (${theme})`, async ({
    browser,
  }, testInfo) => {
    const context = await browser.newContext({
      ...REDUCED,
      baseURL: testInfo.project.use.baseURL!,
    });
    await context.addCookies(cookies(theme));
    const page = await context.newPage();
    await page.goto("/dashboard/login");
    expect(await audit(page)).toEqual([]);
    await expect(page).toHaveTitle("Sign in · Mnemosyne");
    await context.close();
  });

  for (const room of ROOMS) {
    test(`${room} has no serious accessibility violation (${theme})`, async ({
      browser,
    }, testInfo) => {
      const context = await browser.newContext({
        ...REDUCED,
        baseURL: testInfo.project.use.baseURL!,
        storageState: storage,
      });
      await context.addCookies(cookies(theme));
      const page = await context.newPage();
      const response = await page.goto(`/dashboard${room === "/" ? "" : room}`);
      expect(await audit(page)).toEqual([]);
      // Lethe owns the page inside the shell: a 404, the sidebar, one h1, no room header.
      if (room === NOT_FOUND_UNDER_A_ROOM)
        expect(await inShellNotFoundProblems(page, response?.status())).toEqual([]);
      // "{page name} · Mnemosyne", never the bare product name.
      await expect(page).toHaveTitle(/^\S.* · Mnemosyne$/);
      await context.close();
    });
  }

  test(`${NOT_FOUND_FOR_A_READER} for a reader has no serious accessibility violation (${theme})`, async ({
    browser,
  }, testInfo) => {
    const context = await browser.newContext({
      ...REDUCED,
      baseURL: testInfo.project.use.baseURL!,
      storageState: readerStorage,
    });
    await context.addCookies(cookies(theme));
    const page = await context.newPage();
    const response = await page.goto(`/dashboard${NOT_FOUND_FOR_A_READER}`);
    expect(await audit(page)).toEqual([]);
    // Not a superadmin: the same in-shell 404 as an address that does not exist.
    expect(await inShellNotFoundProblems(page, response?.status())).toEqual([]);
    await expect(page).toHaveTitle(/^\S.* · Mnemosyne$/);
    await context.close();
  });

  // The palette open: a modal dialog over the page, with a search settled in it.
  for (const room of ["/", "/admin/keys"] as const) {
    test(`the palette open over ${room} has no serious accessibility violation (${theme})`, async ({
      browser,
    }, testInfo) => {
      const context = await browser.newContext({
        ...REDUCED,
        baseURL: testInfo.project.use.baseURL!,
        storageState: storage,
      });
      await context.addCookies(cookies(theme));
      const page = await context.newPage();
      await page.goto(`/dashboard${room === "/" ? "" : room}`);
      await page.locator("h1").first().waitFor();
      await openPalette(page);
      expect(await audit(page)).toEqual([]);
      await context.close();
    });
  }

  // An empty workspace: the palace rooms' empty states (the tablet, the empty catalog and
  // columbarium, the empty constellation).
  for (const room of EMPTY_ROOMS) {
    test(`${room} empty has no serious accessibility violation (${theme})`, async ({
      browser,
    }, testInfo) => {
      const context = await browser.newContext({
        ...REDUCED,
        baseURL: testInfo.project.use.baseURL!,
        storageState: emptyStorage,
      });
      await context.addCookies(cookies(theme));
      const page = await context.newPage();
      await page.goto(`/dashboard${room === "/" ? "" : room}`);
      // Past "Loading graph…": the empty state is an EmptyState section.
      if (room === "/relations") await page.getByTestId("sky-overlay").locator("section").waitFor();
      expect(await audit(page)).toEqual([]);
      await expect(page).toHaveTitle(/^\S.* · Mnemosyne$/);
      await context.close();
    });
  }

  // The palace rooms with data: an open memory and niche, a recall that ran, a selected star.
  for (const id of PALACE_STATES) {
    test(`/${id} with data has no serious accessibility violation (${theme})`, async ({
      browser,
    }, testInfo) => {
      const context = await browser.newContext({
        ...REDUCED,
        baseURL: testInfo.project.use.baseURL!,
        storageState: storage,
      });
      await context.addCookies(cookies(theme));
      const page = await context.newPage();
      const { path, prepare } = palaceState(id, "en-US");
      await page.goto(`/dashboard${path}`);
      await page.locator("h1").first().waitFor();
      await prepare?.(page);
      expect(await audit(page)).toEqual([]);
      await expect(page).toHaveTitle(/^\S.* · Mnemosyne$/);
      await context.close();
    });
  }
}
