import { expect, test } from "@playwright/test";
import {
  ACCOUNTS,
  INVALID_LOGIN,
  fillLogin,
  formAlert,
  sidebarIdentity,
  signIn,
  state,
} from "./support";

/**
 * Email login against the real server (openspec/dashboard/spec.md §2.2–2.3).
 * IDs refer to openspec/dashboard/login-failure-modes.md.
 */
test.describe("email login", () => {
  test("AUTH-01 owner signs in and lands on Home with role and workspace in the sidebar", async ({
    page,
  }) => {
    await signIn(page, ACCOUNTS.owner.email, ACCOUNTS.owner.password);
    const sidebar = sidebarIdentity(page);
    await expect(sidebar.role("Owner")).toBeVisible();
    await expect(sidebar.workspace(state().ownerWorkspaceName)).toBeVisible();
    // Home is the atrium: it owns the h1 (no room header strip for scene rooms).
    await expect(page.getByRole("heading", { level: 1, name: /The atrium/ })).toBeVisible();
  });

  test("AUTH-01 email is trimmed and case-insensitive", async ({ page }) => {
    await signIn(page, `  ${ACCOUNTS.owner.email.toUpperCase()} `, ACCOUNTS.owner.password);
  });

  test("AUTH-02 wrong password and unknown email get the same focused error and no session", async ({
    page,
  }) => {
    for (const [email, password] of [
      [ACCOUNTS.owner.email, "not the owner password"],
      ["nobody@e2e.test", "whatever password"],
    ] as const) {
      await fillLogin(page, email, password);
      const alert = formAlert(page);
      await expect(alert).toHaveText(INVALID_LOGIN);
      await expect(alert).toBeFocused();
      await expect(page).toHaveURL(/\/dashboard\/login/);
    }
    expect((await page.context().cookies()).map((c) => c.name)).not.toContain("mnemo_dash_token");
  });

  test("AUTH-14 a read-only member sees the atrium without admin-only notices and the viewer role", async ({
    page,
  }) => {
    await signIn(page, ACCOUNTS.reader.email, ACCOUNTS.reader.password);
    // Members read trimmed stats instead of a "stats are admin-only" notice.
    await expect(page.getByRole("heading", { level: 1, name: /The atrium/ })).toBeVisible();
    await expect(page.getByText(/available to workspace administrators/)).toHaveCount(0);
    const sidebar = sidebarIdentity(page);
    await expect(sidebar.role("Viewer")).toBeVisible();
    await expect(sidebar.workspace(state().teamWorkspaceName)).toBeVisible();
  });

  test("AUTH-05 a member of two workspaces chooses one before entering", async ({ page }) => {
    await fillLogin(page, ACCOUNTS.multi.email, ACCOUNTS.multi.password);
    await expect(page.getByText(`Signed in as ${ACCOUNTS.multi.email}`)).toBeVisible();
    const select = page.getByLabel("Workspace");
    await expect(select).toBeFocused();
    await expect(select.locator("option")).toHaveText([
      `${state().teamWorkspaceName} — Contributor`,
      `${state().multiPersonalWorkspaceName} — Owner`,
    ]);
    // The pending selection grants no dashboard access by itself.
    expect((await page.context().cookies()).map((c) => c.name)).not.toContain("mnemo_dash_token");

    await select.selectOption({ label: `${state().teamWorkspaceName} — Contributor` });
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page).toHaveURL(/\/dashboard\/?$/);
    const sidebar = sidebarIdentity(page);
    await expect(sidebar.role("Contributor")).toBeVisible();
    await expect(sidebar.workspace(state().teamWorkspaceName)).toBeVisible();
  });

  test("AUTH-05 the next login starts on the workspace chosen last time", async ({ page }) => {
    await fillLogin(page, ACCOUNTS.multi.email, ACCOUNTS.multi.password);
    // Not the first option: the default would otherwise pass for the wrong reason.
    const personal = `${state().multiPersonalWorkspaceName} — Owner`;
    await page.getByLabel("Workspace").selectOption({ label: personal });
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page).toHaveURL(/\/dashboard\/?$/);
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/dashboard\/login/);

    await fillLogin(page, ACCOUNTS.multi.email, ACCOUNTS.multi.password);
    await expect(page.getByLabel("Workspace").locator("option:checked")).toHaveText(personal);
  });

  test("AUTH-03 five wrong passwords lock the account, then even the right one is refused", async ({
    page,
  }) => {
    for (let attempt = 1; attempt <= 5; attempt++) {
      await fillLogin(page, ACCOUNTS.locked.email, `wrong password number ${attempt}`);
      await expect(formAlert(page)).toHaveText(INVALID_LOGIN);
    }
    // Same generic 401 while locked: never a 503 and never a hint of the lock.
    const response = page.waitForResponse("**/dashboard/auth/login");
    await fillLogin(page, ACCOUNTS.locked.email, ACCOUNTS.locked.password);
    expect((await response).status()).toBe(401);
    await expect(formAlert(page)).toHaveText(INVALID_LOGIN);
    await expect(page).toHaveURL(/\/dashboard\/login/);
  });

  test("API key sign-in still works and My account explains password changes need email login", async ({
    page,
  }) => {
    await page.goto("/dashboard/login");
    await page.getByRole("button", { name: "Sign in with API key" }).click();
    await page.getByLabel("API key").fill(state().apiKey);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL(/\/dashboard\/?$/);
    await expect(sidebarIdentity(page).workspace(state().teamWorkspaceName)).toBeVisible();

    await page.getByRole("link", { name: "My account" }).click();
    await expect(
      page.getByText("Sign in with email and password to change your password.")
    ).toBeVisible();
  });

  test("logging out ends the session", async ({ page }) => {
    await signIn(page, ACCOUNTS.owner.email, ACCOUNTS.owner.password);
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/dashboard\/login/);
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/dashboard\/login/);
  });
});
