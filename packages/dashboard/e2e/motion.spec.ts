import { expect, test, type Page } from "@playwright/test";
import { adminStorageState, measureLoad } from "./support";

let storage: Awaited<ReturnType<typeof adminStorageState>>;

test.beforeAll(async ({ browser }, testInfo) => {
  storage = await adminStorageState(browser, testInfo.project.use.baseURL!);
});

const animations = (page: Page, states: string[]) =>
  page.evaluate(
    (wanted) => document.getAnimations().filter((a) => wanted.includes(a.playState)).length,
    states
  );

test("reduced motion: nothing is animating on / or /login", async ({ browser }, testInfo) => {
  const baseURL = testInfo.project.use.baseURL!;
  const signedOut = await browser.newContext({ baseURL, reducedMotion: "reduce" });
  const login = await signedOut.newPage();
  await login.goto("/dashboard/login");
  await login.locator("h1").first().waitFor();
  expect(await animations(login, ["running"])).toBe(0);
  await signedOut.close();

  const signedIn = await browser.newContext({
    baseURL,
    reducedMotion: "reduce",
    storageState: storage,
  });
  const home = await signedIn.newPage();
  await home.goto("/dashboard");
  await home.locator("h1").first().waitFor();
  expect(await animations(home, ["running"])).toBe(0);
  await signedIn.close();
});

test("without reduced motion /login animates", async ({ browser }, testInfo) => {
  const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL! });
  const page = await context.newPage();
  await page.goto("/dashboard/login");
  await page.locator("h1").first().waitFor();
  expect(await animations(page, ["running", "finished"])).toBeGreaterThan(0);
  await context.close();
});

test("performance: LCP under 2.5 s and at most 300 KB of images", async ({ browser }, testInfo) => {
  for (const [path, signedIn] of [
    ["/dashboard/login", false],
    ["/dashboard", true],
  ] as const) {
    const context = await browser.newContext({
      baseURL: testInfo.project.use.baseURL!,
      ...(signedIn ? { storageState: storage } : {}),
    });
    const page = await context.newPage();
    const { lcp, images: imageBytes } = await measureLoad(page, path);
    // Shown in the report next to the test: the measured numbers, not just pass or fail.
    testInfo.annotations.push({
      type: path,
      description: `LCP ${Math.round(lcp)} ms, images ${imageBytes} B`,
    });
    console.log(`${path}: LCP ${Math.round(lcp)} ms, images ${imageBytes} B`);
    expect(lcp, `${path} LCP`).toBeGreaterThan(0);
    expect(lcp, `${path} LCP`).toBeLessThan(2500);
    expect(imageBytes, `${path} image bytes`).toBeLessThanOrEqual(300 * 1024);
    await context.close();
  }
});
