import { test, expect, type Browser } from "@playwright/test";
import { translate } from "../lib/i18n/core";
import { es } from "../lib/i18n/messages/es";
import { PALACE_STATES, palaceState, type PalaceState } from "./palace-states";
import {
  EMPTY_ROOMS,
  NOT_FOUND_FOR_A_READER,
  NOT_FOUND_UNDER_A_ROOM,
  ACCOUNTS,
  ROOMS,
  adminStorageState,
  emptyStorageState,
  inShellNotFoundProblems,
  openPalette,
  readerStorageState,
  rowAction,
} from "./support";

/**
 * No page scrolls sideways, nothing in main reaches past its edges, nothing in
 * the nav, header or a button is clipped, the room header's text fits inside
 * it, no scene overlay covers the heading, the graph canvas fills its drawing,
 * and engravings (headers, cards and the palace scenes) are drawn at 180 px or
 * more on their short side: at five widths, in both
 * languages and both themes. The palace rooms are measured three ways: bare
 * (seeded workspace), in their data states, and empty (a workspace that holds
 * nothing). A not-found is Lethe's page inside the shell (sidebar, one h1, no room header, a
 * 404), measured twice: an unknown path under a room (admin) and an Installation page opened by
 * a reader. The ⌘K
 * palette is measured open (over Home and a keeper page). Spanish is the longer one, so 375 px is the case that matters.
 */
const WIDTHS = [375, 768, 1280, 1440, 1920];
const LOCALES = ["en-US", "es-419"] as const;
const THEMES = ["light", "dark"] as const;

let storage: string;
let emptyStorage: string;
let readerStorage: string;

test.beforeAll(async ({ browser }, testInfo) => {
  storage = await adminStorageState(browser, testInfo.project.use.baseURL!);
  emptyStorage = await emptyStorageState(browser, testInfo.project.use.baseURL!);
  readerStorage = await readerStorageState(browser, testInfo.project.use.baseURL!);
});

async function visit(
  browser: Browser,
  baseURL: string,
  combo: { width: number; locale: string; theme: string },
  session: string | undefined
) {
  const context = await browser.newContext({
    baseURL,
    // The entrance animations move things by a few pixels; this spec measures the layout.
    reducedMotion: "reduce",
    viewport: { width: combo.width, height: 900 },
    ...(session ? { storageState: session } : {}),
  });
  await context.addCookies(
    [
      { name: "mnemo_locale", value: combo.locale },
      { name: "mnemo_theme", value: combo.theme },
    ].map((c) => ({ ...c, domain: "localhost", path: "/dashboard" }))
  );
  return context;
}

for (const width of WIDTHS) {
  for (const locale of LOCALES) {
    for (const theme of THEMES) {
      test(`no overflow at ${width}px, ${locale}, ${theme}`, async ({ browser }, testInfo) => {
        test.setTimeout(180_000);
        const baseURL = testInfo.project.use.baseURL!;
        const combo = { width, locale, theme };
        const problems: string[] = [];

        type Visit = {
          path: string;
          session?: string;
          empty?: boolean;
          /** Lethe's not-found inside the shell is expected here. */
          notFound?: boolean;
          /** Names the screenshot of a state that is not the bare room. */
          state?: string;
          prepare?: PalaceState["prepare"];
        };
        const pages: Visit[] = [
          { path: "/login" },
          ...ROOMS.map((path) => ({
            path,
            session: storage,
            notFound: path === NOT_FOUND_UNDER_A_ROOM,
          })),
          // Not a superadmin: the Installation page is Lethe's not-found, inside the shell.
          { path: NOT_FOUND_FOR_A_READER, session: readerStorage, state: "reader", notFound: true },
          // The palace rooms with their seeded data: an open memory and niche, a recall, a selected star.
          ...PALACE_STATES.map((id) => ({ ...palaceState(id, locale), session: storage })),
          // And empty: what a new workspace sees before its first memory.
          ...EMPTY_ROOMS.map((path) => ({ path, session: emptyStorage, empty: true })),
          // The palette open, with results, over a palace scene and over a keeper page.
          ...(["/", "/admin/keys"] as const).map((path) => ({
            path,
            session: storage,
            state: "palette",
            prepare: openPalette,
          })),
        ];
        for (const { path, session, empty, notFound, prepare, state } of pages) {
          const context = await visit(browser, baseURL, combo, session);
          const page = await context.newPage();
          const response = await page.goto(`/dashboard${path === "/" ? "" : path}`);
          // :visible — on a not-found the room header's h1 is in the DOM under display:none.
          await page.locator("h1:visible").first().waitFor();
          if (notFound)
            for (const p of await inShellNotFoundProblems(page, response?.status()))
              problems.push(`${path}${state ? ` (${state})` : ""}: ${p}`);
          if (session && /\/login/.test(page.url())) problems.push(`${path}: bounced to login`);
          await prepare?.(page);
          // The graph draws once it has loaded and its scene is measured: wait for the graph or
          // the empty state (an EmptyState is a section), not the "Loading graph…" overlay.
          if (path === "/relations")
            await page
              .locator("[data-testid=sky-graph] canvas, [data-testid=sky-overlay] section")
              .first()
              .waitFor();

          const result = await page.evaluate(() => {
            const out: string[] = [];
            const label = (e: Element) =>
              `${e.tagName.toLowerCase()} "${(e.textContent ?? "").trim().slice(0, 40)}"`;
            const visible = (r: DOMRect) => r.width > 0 && r.height > 0;

            // Something wider than its box (sr-only text is 1 px wide on purpose).
            for (const e of document.querySelectorAll(
              "nav *:not(.sr-only), header *:not(.sr-only), button, nav, header"
            ))
              if (e.scrollWidth > e.clientWidth + 1) out.push(`clipped ${label(e)}`);
            // The sidebar lists every room without a scroll area of its own: the sidebar scrolls.
            for (const e of document.querySelectorAll("aside nav"))
              if (e.scrollHeight > e.clientHeight + 1) out.push(`nav scrolls inside ${label(e)}`);

            // main hides horizontal overflow, so the page width can't show it: measure against main.
            const main = document.querySelector("main");
            if (main) {
              const box = main.getBoundingClientRect();
              const innerClip = (e: Element) => {
                for (let p = e.parentElement; p && p !== main; p = p.parentElement)
                  if (getComputedStyle(p).overflowX !== "visible") return true;
                return false;
              };
              for (const e of main.querySelectorAll("*")) {
                const r = e.getBoundingClientRect();
                if (!visible(r) || innerClip(e)) continue;
                if (r.left < box.left - 1 || r.right > box.right + 1)
                  out.push(`past the edge of main ${label(e)}`);
              }
            }

            // The room header clips what leaves it: its title and subtitle must fit inside.
            // Scene rooms (Home, Graph) have no header; their heading must fit its own box.
            const header =
              document.querySelector("main > header") ??
              document.querySelector("[data-testid=scene-heading]");
            if (header) {
              const hb = header.getBoundingClientRect();
              const h1 = header.querySelector("h1");
              const text = [h1, h1?.parentElement, ...header.querySelectorAll("p")];
              for (const e of text) {
                if (!e) continue;
                const r = e.getBoundingClientRect();
                if (!visible(r)) continue;
                if (
                  r.top < hb.top - 1 ||
                  r.bottom > hb.bottom + 1 ||
                  r.left < hb.left - 1 ||
                  r.right > hb.right + 1
                )
                  out.push(`outside the room header ${label(e)}`);
                if (e.scrollHeight > e.clientHeight + 1) out.push(`cut off ${label(e)}`);
              }
              if (header.scrollHeight > header.clientHeight + 1)
                out.push(`cut off ${label(header)}`);
            }

            // The open palette stays inside the viewport and its list does not scroll sideways.
            const palette = document.querySelector("dialog[open]");
            if (palette) {
              const r = palette.getBoundingClientRect();
              if (r.left < -1 || r.right > window.innerWidth + 1 || r.top < -1)
                out.push("the palette leaves the viewport");
              const list = palette.querySelector("[role=listbox]");
              if (list && list.scrollWidth > list.clientWidth + 1)
                out.push("the palette list scrolls sideways");
            }

            // A scene overlay (the graph's loading, error and empty states) never covers the heading.
            const h1 = document.querySelector("h1");
            const overlay = document.querySelector("[data-testid=sky-overlay]");
            if (h1 && overlay) {
              const a = h1.getBoundingClientRect();
              const b = overlay.getBoundingClientRect();
              if (a.bottom > b.top && a.top < b.bottom && a.right > b.left && a.left < b.right)
                out.push(`the scene overlay covers ${label(h1)}`);
            }

            // The graph's canvas fills its drawing band (labels are drawn on it at 12 px).
            const sky = document.querySelector("[data-testid=sky-graph]");
            const canvas = sky?.querySelector("canvas");
            if (sky && canvas) {
              const sb = sky.getBoundingClientRect();
              const cb = canvas.getBoundingClientRect();
              if (Math.abs(cb.width - sb.width) > 2 || Math.abs(cb.height - sb.height) > 2)
                out.push(
                  `graph canvas ${Math.round(cb.width)}x${Math.round(cb.height)} in a ` +
                    `${Math.round(sb.width)}x${Math.round(sb.height)} drawing`
                );
            }

            // Engravings are drawn at 180 px or more on their short side (crops are fine):
            // the room headers and cards, the constellation.
            for (const img of document.querySelectorAll(
              "main > header img, [data-testid=room-card] img, main figure img, " +
                ".sky-scene img, main [data-lethe] img"
            )) {
              // Not drawn at all: the room header under display:none on a not-found (globals.css).
              if (!img.checkVisibility()) continue;
              const r = img.getBoundingClientRect();
              const short = Math.min(r.width, r.height);
              if (short < 179.5) out.push(`engraving drawn at ${Math.round(short)} px`);
            }

            return {
              page: document.documentElement.scrollWidth - window.innerWidth,
              problems: out,
            };
          });
          const where = empty ? `${path} (empty)` : state ? `${path} (${state})` : path;
          if (result.page > 0) problems.push(`${where}: page scrolls sideways by ${result.page}px`);
          for (const c of new Set(result.problems)) problems.push(`${where}: ${c}`);

          const name = `${path.replace(/\W+/g, "_")}${state ? `_${state}` : prepare ? "_with_data" : empty ? "_empty" : ""}-${width}-${locale}-${theme}`;
          // On disk too (test-results/), so a run's screenshots can be opened by name.
          const file = testInfo.outputPath(`${name}.png`);
          await page.screenshot({ path: file, fullPage: true });
          await testInfo.attach(name, { path: file, contentType: "image/png" });
          await context.close();
        }
        expect(problems).toEqual([]);
      });
    }
  }
}

// The phone drawer lists every room without clipping a label, in the longer language too: the
// sweep above measures the nav only where it shows (the drawer is closed on phones).
for (const locale of LOCALES) {
  test(`the phone drawer clips no label at 375px, ${locale}`, async ({ browser }, testInfo) => {
    const combo = { width: 375, locale, theme: "light" };
    const context = await visit(browser, testInfo.project.use.baseURL!, combo, storage);
    const page = await context.newPage();
    await page.goto("/dashboard/admin/keys");
    await page.locator('button[aria-controls="dashboard-navigation"]').click();
    const nav = page.locator("aside#dashboard-navigation nav").first();
    await expect(nav).toBeVisible();
    const clipped = await page.evaluate(() => {
      const label = (e: Element) => `${e.tagName.toLowerCase()} "${(e.textContent ?? "").trim()}"`;
      return [...document.querySelectorAll("aside#dashboard-navigation *:not(.sr-only)")]
        .filter((e) => e.getClientRects().length > 0 && e.scrollWidth > e.clientWidth + 1)
        .map(label);
    });
    // Every room and keeper link of an admin session is in it, and reachable.
    expect(await nav.getByRole("link").count()).toBeGreaterThanOrEqual(10);
    expect(clipped).toEqual([]);
    const file = testInfo.outputPath(`drawer-375-${locale}.png`);
    await page.screenshot({ path: file, fullPage: true });
    await testInfo.attach(`drawer-375-${locale}`, { path: file, contentType: "image/png" });
    await context.close();
  });
}

// The sidebar's "Sign out" stays on one line: the footer row shares 220 px with "My account", so
// an unprotected button shrinks to its longest word and wraps (desktop sidebar and phone drawer).
for (const locale of LOCALES) {
  for (const width of [1440, 375]) {
    test(`Sign out stays on one line at ${width}px, ${locale}`, async ({ browser }, testInfo) => {
      const combo = { width, locale, theme: "light" };
      const context = await visit(browser, testInfo.project.use.baseURL!, combo, storage);
      const page = await context.newPage();
      await page.goto("/dashboard/admin/keys");
      if (width === 375) await page.locator('button[aria-controls="dashboard-navigation"]').click();
      const button = page.locator("aside#dashboard-navigation button").last();
      await expect(button).toBeVisible();
      // Lines of the label itself: since the museum-index sidebar the button also holds a
      // 32 px icon box, whose rect sits at another top and is not a second line of text.
      const lines = await button.evaluate((b) => {
        const label = [...b.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).at(-1)!;
        const range = document.createRange();
        range.selectNodeContents(label);
        return new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size;
      });
      expect(lines).toBe(1);
      expect(await button.evaluate((b) => b.scrollWidth - b.clientWidth)).toBeLessThanOrEqual(1);
      await context.close();
    });
  }
}

// A failed action shows its alert inside the record's row (a flex-wrap row), on a phone, in the
// longer language: the alert stays inside the row and the page does not scroll sideways.
test("an alert inside an installation user row fits at 375px, es-419", async ({
  browser,
}, testInfo) => {
  const combo = { width: 375, locale: "es-419", theme: "light" };
  const context = await visit(browser, testInfo.project.use.baseURL!, combo, storage);
  const page = await context.newPage();
  await page.route("**/dashboard/api/instance/users/*/reset-link", (route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: "{}" })
  );
  await page.goto("/dashboard/installation/users");
  const name = translate(es, "installation.users.resetLinkAria", { email: ACCOUNTS.reader.email });
  await rowAction(
    page,
    ACCOUNTS.reader.email,
    name,
    translate(es, "ui.rowActions", { name: "" }).trim()
  );
  const alert = page.locator("li").getByRole("alert");
  await expect(alert).toBeVisible();
  const [row, box] = await Promise.all([
    alert.locator("xpath=ancestor::li[1]").boundingBox(),
    alert.boundingBox(),
  ]);
  expect(box!.x).toBeGreaterThanOrEqual(row!.x - 1);
  expect(box!.x + box!.width).toBeLessThanOrEqual(row!.x + row!.width + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
  const file = testInfo.outputPath("users-alert-375-es-419-light.png");
  await page.screenshot({ path: file, fullPage: true });
  await testInfo.attach("users-alert-375-es-419-light", { path: file, contentType: "image/png" });
  await context.close();
});
