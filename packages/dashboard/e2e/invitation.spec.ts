import { expect, test, type Browser, type Page } from "@playwright/test";
import {
  ACCOUNTS,
  INVALID_LINK,
  fillLogin,
  formAlert,
  sidebarIdentity,
  signInToWorkspace,
  state,
  rowAction,
} from "./support";

/**
 * Invitation links (accounts stage A): an owner of E2E Team invites people and
 * the invitee opens the link in a fresh browser context, as a stranger would.
 */
const NEW_EMAIL = "new@e2e.test";
const NEW_PASSWORD = "new e2e password";

async function invite(page: Page, email: string, role: string): Promise<string> {
  await page.goto("/dashboard/admin/members");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Role", { exact: true }).selectOption({ label: role });
  await page.getByRole("button", { name: "Create invitation" }).click();
  const field = page.getByLabel(`Invitation link for ${email}`);
  await expect(field).toBeVisible();
  await expect(field).toHaveJSProperty("readOnly", true);
  await expect(page.getByText(`Shown once. Share it only with ${email}.`)).toBeVisible();
  return field.inputValue();
}

async function strangerOpens(
  browser: Browser,
  link: string,
  viewport?: { width: number; height: number }
) {
  const context = await browser.newContext(viewport ? { viewport } : {});
  const page = await context.newPage();
  const response = await page.goto(link);
  return { context, page, response };
}

test.describe("invitation links", () => {
  test.beforeEach(async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await signInToWorkspace(
      page,
      ACCOUNTS.admin.email,
      ACCOUNTS.admin.password,
      "E2E Team — Owner"
    );
  });

  test("a new account opens the copied link once, sets a password and joins as contributor", async ({
    page,
    browser,
  }) => {
    const link = await invite(page, NEW_EMAIL, "Contributor");
    expect(new URL(link).pathname).toMatch(/^\/dashboard\/link\/[A-Za-z0-9_-]+$/);

    await page.getByRole("button", { name: "Copy" }).click();
    await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(link);

    const stranger = await strangerOpens(browser, link);
    expect(await stranger.response!.headerValue("referrer-policy")).toBe("no-referrer");
    const sp = stranger.page;
    await expect(sp.getByText("Create your account to join E2E Team.")).toBeVisible();
    await expect(sp.getByLabel(/Display name/)).toBeFocused();
    await sp.getByLabel(/Display name/).fill("Nora New");

    // A weak password is refused inside the form and the link stays usable.
    await sp.getByLabel("Password").fill("short");
    await sp.getByRole("button", { name: "Join E2E Team" }).click();
    const alert = formAlert(sp);
    await expect(alert).toContainText("at least 12 characters");
    await expect(alert).toBeFocused();

    await sp.getByLabel("Password").fill(NEW_PASSWORD);
    await sp.getByRole("button", { name: "Join E2E Team" }).click();
    await expect(sp).toHaveURL(/\/dashboard\/?$/);
    const sidebar = sidebarIdentity(sp);
    await expect(sidebar.role("Contributor")).toBeVisible();
    await expect(sidebar.workspace(state().teamWorkspaceName)).toBeVisible();

    // The same link never works twice.
    const again = await strangerOpens(browser, link);
    await expect(again.page.getByText(INVALID_LINK)).toBeVisible();
    await again.context.close();
    await stranger.context.close();

    // The member now shows up for the owner.
    await page.goto("/dashboard/admin/members");
    await expect(page.getByLabel(`Role of ${NEW_EMAIL}`)).toHaveValue("write");
    await expect(page.getByLabel(`Invitation link for ${NEW_EMAIL}`)).toHaveCount(0);
  });

  test("an existing account signs in, accepts, and the next login offers both workspaces", async ({
    page,
    browser,
  }) => {
    const { email, password } = ACCOUNTS.joiner;
    const link = await invite(page, email, "Viewer");

    const stranger = await strangerOpens(browser, link, { width: 375, height: 800 });
    const sp = stranger.page;
    await expect(sp.getByText("You have been invited to E2E Team.")).toBeVisible();
    await expect(sp.getByLabel("Password")).toHaveCount(0);
    const overflow = await sp.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow).toBeLessThanOrEqual(0);

    // Accepting without a session of that account is refused inside the form.
    await sp.getByRole("button", { name: "Join E2E Team" }).click();
    await expect(formAlert(sp)).toHaveText(
      "Sign in with the invited email to accept this invitation."
    );
    await expect(formAlert(sp)).toBeFocused();

    await sp.getByRole("link", { name: "Sign in with the invited email" }).click();
    await sp.getByLabel("Email").fill(email);
    await sp.getByLabel("Password").fill(password);
    await sp.getByRole("button", { name: "Sign in", exact: true }).click();
    // Back on the link, now with a session.
    await expect(sp).toHaveURL(/\/dashboard\/link\//);
    await sp.getByRole("button", { name: "Join E2E Team" }).click();
    await expect(sp).toHaveURL(/\/dashboard\/?$/);
    // At phone width the navigation sits behind the menu button.
    await sp.getByRole("button", { name: "Menu" }).click();
    const sidebar = sidebarIdentity(sp);
    await expect(sidebar.role("Viewer")).toBeVisible();
    await expect(sidebar.workspace(state().teamWorkspaceName)).toBeVisible();
    await sp.getByRole("button", { name: "Sign out" }).click();
    await expect(sp).toHaveURL(/\/dashboard\/login/);
    await fillLogin(sp, email, password);
    const select = sp.getByLabel("Workspace");
    await expect(select).toBeFocused();
    await expect(select.locator("option")).toHaveCount(2);
    // The workspace just joined was the last one used.
    await expect(select.locator("option:checked")).toContainText(state().teamWorkspaceName);
    await stranger.context.close();
  });

  test("revoking an invitation kills its link; a new link replaces the old one", async ({
    page,
    browser,
  }) => {
    const email = "revoked@e2e.test";
    const first = await invite(page, email, "Viewer");

    await rowAction(page, email, `New link for ${email}`);
    const shown = page.getByLabel(`Invitation link for ${email}`);
    await expect(shown).not.toHaveValue(first);
    const second = await shown.inputValue();
    const old = await strangerOpens(browser, first);
    await expect(old.page.getByText(INVALID_LINK)).toBeVisible();
    await old.context.close();

    await rowAction(page, email, `Revoke invitation for ${email}`);
    await page
      .getByRole("dialog", { name: `Revoke invitation for ${email}` })
      .getByRole("button", { name: "Revoke" })
      .click();
    await expect(page.getByRole("button", { name: `Actions for ${email}` })).toHaveCount(0);
    const revoked = await strangerOpens(browser, second);
    await expect(revoked.page.getByText(INVALID_LINK)).toBeVisible();
    await revoked.context.close();
  });
});
