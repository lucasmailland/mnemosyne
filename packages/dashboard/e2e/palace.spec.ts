import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { translate, type Locale, type MessageKey, type Vars } from "../lib/i18n/core";
import { en } from "../lib/i18n/messages/en";
import { es } from "../lib/i18n/messages/es";
import { adminStorageState, measureLoad, serverRequest, state } from "./support";

/**
 * The five rooms of the palace with real data (seeded by global-setup through
 * the API, see seed.ts), in both languages: the atrium tells the day, the
 * catalog opens a superseded memory with its two clocks and provenance, recall
 * shows the pipeline and a "why", the columbarium opens a niche and the
 * constellation selects a node from the keyboard. Strings come from the
 * dictionaries, so a rewording never breaks the spec.
 */
const MESSAGES = { "en-US": en, "es-419": es } as const;
const seed = () => state().palace;

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
  test.describe(`the palace, ${locale}`, () => {
    const t = (key: MessageKey, vars?: Vars) => translate(MESSAGES[locale], key, vars, locale);
    let context: BrowserContext;
    let page: Page;

    test.beforeAll(async ({ browser }, testInfo) => {
      context = await open(browser, testInfo.project.use.baseURL!, locale);
      page = await context.newPage();
    });
    test.afterAll(async () => {
      await context.close();
    });

    test("Home leads with its figures and charts, and keeps the conflict card and the day", async () => {
      await page.goto("/dashboard");
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

      // One line of today, every clause true: the seeded conflict is open.
      const summary = page.getByTestId("home-summary");
      await expect(summary).toContainText(t("home.summary.conflicts", { count: 1 }));

      // The band: live memories with the 14-day sparkline, and the open conflict.
      const figures = page.getByTestId("atrium-figures");
      await expect(figures).toContainText(t("home.tiles.live"));
      await expect(
        figures.getByRole("img", { name: t("home.tiles.liveSpark").split(":")[0] })
      ).toBeVisible();
      await expect(figures).toContainText(t("home.tiles.conflictsSome"));

      // Writes per day: a chart with its table twin, which the toggle shows in its place.
      const writes = page
        .getByTestId("chart-card")
        .filter({ has: page.getByRole("heading", { name: t("home.charts.writes") }) });
      await expect(writes.getByRole("table")).toHaveCount(1);
      await writes.getByRole("button", { name: t("charts.viewTable") }).click();
      await expect(writes.getByRole("table")).toBeVisible();
      await expect(writes.getByRole("row")).toHaveCount(15);
      await writes.getByRole("button", { name: t("charts.viewTable"), pressed: true }).click();
      // Memory by kind is drawn from the live facts the session can read.
      await expect(
        page.getByRole("heading", { level: 2, name: t("home.charts.kinds") })
      ).toBeVisible();

      const card = page.locator("#atrium-conflict");
      await expect(card).toContainText(t("home.needs.pairTitle"));
      for (const statement of seed().conflictStatements)
        await expect(card).toContainText(statement);
      // The admin writes: both resolutions are offered next to the lineage link.
      await expect(card.getByRole("button", { name: t("home.needs.keepNewer") })).toBeVisible();
      await expect(card.getByRole("button", { name: t("home.needs.keepBoth") })).toBeVisible();
      await expect(card.getByRole("link", { name: t("home.needs.showLineage") })).toHaveAttribute(
        "href",
        /\/browser\?open=/
      );

      // The day, as remembered: a list of today's events, each with its time and its kind
      // (which events fit the window changes with what ran before, so only its shape is asserted),
      // and every kind is said in words of this language, never a raw key.
      const day = page.getByTestId("atrium-day");
      await expect(day.getByRole("listitem").first()).toBeVisible();
      const kinds = Object.values(MESSAGES[locale].home.event) as string[];
      const tags = await day.locator("li > span:last-child").allTextContents();
      expect(tags.length).toBeGreaterThan(0);
      for (const tag of tags) expect(kinds).toContain(tag.trim());
      // Each row opens its memory in the Explorer.
      await expect(day.getByRole("link").first()).toHaveAttribute("href", /\/browser\?/);
    });

    test("the catalog opens a superseded memory with its two clocks and its provenance", async () => {
      const {
        supersededFactId,
        supersededStatement,
        currentFactId,
        currentStatement,
        episodeTitle,
      } = seed();
      await page.goto(`/dashboard/browser?open=${supersededFactId}`);
      const plate = page.getByTestId("catalog-plate");
      await expect(plate).toContainText(supersededStatement);

      // The world clock has ended (hatched); the memory was closed, not erased.
      await expect(plate.getByTestId("clock-world")).toHaveAttribute("data-state", "closed");
      // Mnemosyne stopped holding it when the successor arrived: that clock has ended too.
      await expect(plate.getByTestId("clock-known")).toHaveAttribute("data-state", "closed");
      await expect(plate).toContainText(t("browser.clocks.title"));

      // Provenance: what superseded it, linking to the successor.
      const chain = plate.getByTestId("catalog-chain");
      await expect(chain).toContainText(t("browser.chain.supersededBy"));
      await expect(chain.getByRole("link", { name: currentStatement })).toHaveAttribute(
        "href",
        new RegExp(`open=${currentFactId}`)
      );

      // And the other end of the chain: the replacement supersedes it and came from an episode.
      await page.goto(`/dashboard/browser?open=${currentFactId}`);
      const successor = page.getByTestId("catalog-plate").getByTestId("catalog-chain");
      await expect(successor).toContainText(t("browser.chain.supersedes"));
      await expect(successor.getByRole("link", { name: supersededStatement })).toBeVisible();
      await expect(successor.getByRole("link", { name: episodeTitle })).toBeVisible();
    });

    test("recall runs a query and shows the pipeline and a why", async () => {
      // Metered calls, counted on the wire: none on load or while typing, one per click,
      // and one explain for the query however many hits are expanded.
      const sent: string[] = [];
      const count = (request: { url(): string }) => {
        const path = new URL(request.url()).pathname;
        if (path.startsWith("/dashboard/api/recall")) sent.push(path);
      };
      page.on("request", count);
      const calls = (path: string) => sent.filter((p) => p === path).length;

      await page.goto("/dashboard/recall");
      await page.getByRole("textbox", { name: t("recall.placeholder") }).fill(seed().recallQuery);
      // Metered: nothing runs until the user asks.
      await expect(page.getByTestId("lethe-strip")).toHaveCount(0);
      expect(sent).toEqual([]);

      await page.getByRole("button", { name: t("recall.run"), exact: true }).click();

      const strip = page.getByTestId("lethe-strip");
      await expect(strip).toBeVisible();
      await expect(strip).toContainText(t("recall.stageTotal"));
      expect(calls("/dashboard/api/recall")).toBe(1);
      const hits = page.getByTestId("lethe-hit");
      await expect(hits.nth(1)).toBeVisible();

      const why = hits.first().getByRole("button", { name: t("recall.why") });
      await expect(why).toHaveAttribute("aria-expanded", "false");
      await why.click();
      await expect(why).toHaveAttribute("aria-expanded", "true");
      await expect(hits.first()).toContainText(t("recall.provenance"));
      await expect(hits.first()).toContainText(t("recall.worth"));
      const second = hits.nth(1).getByRole("button", { name: t("recall.why") });
      await second.click();
      await expect(second).toHaveAttribute("aria-expanded", "true");
      expect(calls("/dashboard/api/recall/explain")).toBe(1);
      expect(calls("/dashboard/api/recall")).toBe(1);
      page.off("request", count);
    });

    test("the columbarium opens a niche", async () => {
      const { episodeId, episodeTitle } = seed();
      await page.goto("/dashboard/sessions");
      const grid = page.getByTestId("columbarium-grid");
      await grid.getByRole("link", { name: new RegExp(episodeTitle) }).click();
      await expect(page).toHaveURL(new RegExp(`open=${episodeId}`));

      const niche = page.getByTestId("columbarium-niche");
      await expect(niche).toContainText(t("sessions.narrative"));
      await expect(niche).toContainText("Ana Ferreira");
      await expect(niche.getByTestId("columbarium-timeline")).toBeVisible();
      await expect(niche).toContainText(t("sessions.produced"));
      await expect(niche).toContainText(seed().producedStatement);
    });

    test("the constellation selects a node from the keyboard", async () => {
      await page.goto("/dashboard/relations");
      const sky = page.getByTestId("sky-graph");
      await expect(sky).toBeVisible();

      const nodes = sky.getByRole("button");
      await expect(nodes.first()).toBeVisible();
      // Roving tabindex: one tab stop for the whole graph, never one per node.
      await expect(sky.locator('button[tabindex="0"]')).toHaveCount(1);

      const stop = sky.locator('button[tabindex="0"]');
      await stop.focus();
      const first = await stop.getAttribute("aria-label");
      await page.keyboard.press("ArrowRight");
      const moved = sky.locator("button:focus");
      await expect(moved).toHaveCount(1);
      expect(await moved.getAttribute("aria-label")).not.toBe(first);

      const label = await moved.getAttribute("aria-label");
      await page.keyboard.press("Enter");
      await expect(moved).toHaveAttribute("aria-pressed", "true");
      const card = page.getByTestId("sky-card");
      await expect(card).toBeVisible();
      await expect(card.getByRole("heading", { level: 2 })).toBeVisible();
      // The selection is announced (the figures under the sky may still be loading, in their
      // own status region).
      await expect(page.getByRole("status").filter({ hasText: label!.split(",")[0]! })).toHaveCount(
        1
      );

      await page.keyboard.press("Enter");
      await expect(moved).toHaveAttribute("aria-pressed", "false");
      await expect(card).toHaveCount(0);

      // Entering an entity shows its neighbourhood under a trail; Escape twice comes back.
      const entity = sky
        .getByRole("button", { name: new RegExp(`, ${t("graph.kind.entity")}$`) })
        .first();
      const name = (await entity.getAttribute("aria-label"))!.split(",")[0]!;
      await entity.focus();
      await page.keyboard.press("Enter");
      await card.getByRole("button", { name: t("graph.enterLabel", { name }) }).click();
      const trail = page.getByRole("navigation", { name: t("graph.trail") });
      await expect(trail).toContainText(name);
      await expect(
        page.getByRole("button", { name: t("graph.backTo", { name: t("graph.whole") }) })
      ).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(card).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(trail).toHaveCount(0);
      await expect(sky.getByRole("button", { name: new RegExp(`^${name},`) })).toBeFocused();
    });
  });
}

test("keeping both settles a conflict it wrote, and with none left the atrium shows the archive", async ({
  browser,
}, testInfo) => {
  // Its own pair, so the test resolves what it wrote and does not depend on the seed's pair
  // still being open (or on running after the tests that look at it).
  const key = state().apiKey;
  const stamp = Date.now();
  const statements = [
    `The archive check ${stamp} runs after every deploy.`,
    `The archive check ${stamp} never runs after a deploy.`,
  ];
  const [a, b] = statements.map((statement, i) => {
    const res = serverRequest(key, "POST", "/remember", {
      statement,
      topicKey: `e2e/archive-check-${stamp}-${i}`,
    });
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    return (res.body as { id: string }).id;
  });
  const related = serverRequest(key, "POST", "/relations", {
    sourceKind: "fact",
    sourceId: a,
    targetKind: "fact",
    targetId: b,
    relation: "conflicts_with",
    confidence: 0.8,
    judgmentStatus: "pending",
    markedByKind: "agent",
  });
  expect(related.status, JSON.stringify(related.body)).toBeLessThan(300);

  const context = await open(browser, testInfo.project.use.baseURL!, "en-US");
  const page = await context.newPage();
  await page.goto("/dashboard");
  // The whole open queue is listed (APP-044): the card is the item holding the pair written above.
  const card = page.locator("#atrium-conflict > li").filter({ hasText: statements[0]! });
  for (const statement of statements) await expect(card).toContainText(statement);
  await card.getByRole("button", { name: en.home.needs.keepBoth }).click();
  // A resolution cannot be undone, so it is confirmed first.
  await page
    .getByRole("dialog", { name: en.home.needs.confirmBothTitle })
    .getByRole("button", { name: en.home.needs.confirm })
    .click();

  // The outcome is announced and focus lands on the section's heading once the refresh is in.
  await expect(page.getByRole("status").filter({ hasText: /\S/ })).toContainText(
    en.home.needs.keptBoth
  );
  await expect(page.getByRole("heading", { level: 2, name: en.home.needs.title })).toBeFocused();
  // The settled pair leaves the card (its statements stay in the day's events, as they should).
  await expect(page.locator("#atrium-conflict").filter({ hasText: statements[0]! })).toHaveCount(0);

  // Settle whatever else is open (the seed's pair, if no one has yet) for the archive state.
  const left = serverRequest(key, "GET", "/conflicts?limit=20").body as {
    pairs: { relationId: string }[];
  };
  for (const pair of left.pairs) {
    const res = serverRequest(key, "POST", `/conflicts/${pair.relationId}/resolve`, {
      action: "keep_both",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }
  await page.reload();
  const archive = page.getByTestId("atrium-archive");
  await expect(archive).toContainText(en.home.archive.title);
  await expect(page.locator("#atrium-conflict")).toHaveCount(0);
  await context.close();

  // Home in this state stays within the performance budget too (a fresh context: no cache).
  const fresh = await open(browser, testInfo.project.use.baseURL!, "en-US");
  const { lcp, images } = await measureLoad(await fresh.newPage(), "/dashboard");
  testInfo.annotations.push({
    type: "/dashboard with the archive",
    description: `LCP ${Math.round(lcp)} ms, images ${images} B`,
  });
  console.log(`/dashboard with the archive: LCP ${Math.round(lcp)} ms, images ${images} B`);
  expect(lcp).toBeLessThan(2500);
  expect(images).toBeLessThanOrEqual(300 * 1024);
  await fresh.close();
});
