import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { ACCOUNTS, serverRequest, signIn, rowAction } from "./support";

/**
 * API Keys page: every live key of the workspace is listed, whoever created it,
 * and a key can be rotated (new key shown once, old one kept for the grace
 * period) and revoked. Until this spec the page read the wrong field of
 * GET /admin/keys and never listed a single key.
 */
test.describe("API keys", () => {
  test.describe.configure({ mode: "serial" });

  const LABEL = "e2e agent";
  const SCOPES = ["memory:read", "memory:write", "memory:delete"];

  let context: BrowserContext;
  let page: Page;
  let oldKey = "";
  let newKey = "";

  test.beforeAll(async ({ browser }, testInfo) => {
    context = await browser.newContext({ baseURL: testInfo.project.use.baseURL! });
    page = await context.newPage();
    await signIn(page, ACCOUNTS.keyholder.email, ACCOUNTS.keyholder.password);
  });
  test.afterAll(async () => {
    await context.close();
  });

  const rows = () =>
    page.getByRole("list", { name: "API keys" }).getByRole("listitem").filter({ hasText: LABEL });
  const rotatedRow = () => rows().filter({ hasText: "Rotated" });
  const currentRow = () => rows().filter({ hasNotText: "Rotated" });

  test("lists a key created outside this page, with its scopes", async () => {
    const created = await page.request.post("/dashboard/api/admin/keys", {
      data: { label: LABEL, scopes: SCOPES },
    });
    expect(created.status()).toBe(201);
    oldKey = ((await created.json()) as { key: string }).key;

    await page.goto("/dashboard/admin/keys");
    await expect(page.getByText("Could not load keys")).toHaveCount(0);
    await expect(rows()).toHaveCount(1);
    for (const scope of SCOPES) {
      await expect(rows().getByText(scope, { exact: true })).toBeVisible();
    }
  });

  test("rotating shows the new key once; the old one keeps working until the end of the grace period", async () => {
    await rowAction(rows(), LABEL, `Rotate ${LABEL}`);
    await page
      .getByRole("dialog", { name: `Rotate ${LABEL}` })
      .getByRole("button", { name: "Rotate" })
      .click();

    const shown = page.getByRole("region", { name: `New key for ${LABEL}` });
    await expect(shown).toBeVisible();
    await expect(shown).toContainText("will not be shown again");
    newKey = (await shown.locator("code").innerText()).trim();
    expect(newKey).not.toBe(oldKey);
    await expect(shown.getByRole("button", { name: "Copy" })).toBeVisible();

    const me = serverRequest(newKey, "GET", "/me");
    expect(me.status).toBe(200);
    expect((me.body as { scopes: string[] }).scopes).toEqual(expect.arrayContaining(SCOPES));
    expect(serverRequest(oldKey, "GET", "/me").status).toBe(200);

    await expect(rows()).toHaveCount(2);
    await expect(rotatedRow()).toContainText("works until");
    // A rotated key's menu offers Revoke only.
    await rotatedRow()
      .getByRole("button", { name: `Actions for ${LABEL}` })
      .click();
    await expect(rotatedRow().getByRole("menuitem", { name: `Rotate ${LABEL}` })).toHaveCount(0);
    await page.keyboard.press("Escape");

    await shown.getByRole("button", { name: "Done" }).click();
    await expect(shown).toHaveCount(0);
  });

  test("revoking the rotated key ends it now; the new key keeps working", async () => {
    await rowAction(rotatedRow(), LABEL, `Revoke ${LABEL}`);
    await page
      .getByRole("dialog", { name: `Revoke ${LABEL}` })
      .getByRole("button", { name: "Revoke" })
      .click();

    await expect(rows()).toHaveCount(1);
    await expect(currentRow()).toHaveCount(1);
    expect(serverRequest(oldKey, "GET", "/me").status).toBe(401);
    expect(serverRequest(newKey, "GET", "/me").status).toBe(200);
  });
});
