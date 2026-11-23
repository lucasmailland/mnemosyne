import { expect, test } from "@playwright/test";
import { ACCOUNTS, fillLogin, state } from "./support";

/** The first superadmin, created by the bootstrap in global-setup (accounts stage A). */
test.describe("first superadmin", () => {
  test("ADMIN-01 the bootstrap administrator signs in and the session reports isSuperadmin", async ({
    page,
  }) => {
    await fillLogin(page, ACCOUNTS.admin.email, ACCOUNTS.admin.password);
    // Owner of the bootstrap workspace and of its own personal one: pick one.
    const select = page.getByLabel("Workspace");
    await select.selectOption({ index: 0 });
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page).toHaveURL(/\/dashboard\/?$/);
    const res = await page.request.get("/dashboard/auth/session");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.isSuperadmin).toBe(true);
    expect(body.viaInstance).toBe(false);
    expect(body.email).toBe(ACCOUNTS.admin.email);
    expect(state().teamWorkspaceId).toBeTruthy();
  });

  test("ADMIN-02 an ordinary account is not a superadmin", async ({ page }) => {
    await fillLogin(page, ACCOUNTS.owner.email, ACCOUNTS.owner.password);
    await expect(page).toHaveURL(/\/dashboard\/?$/);
    const body = await (await page.request.get("/dashboard/auth/session")).json();
    expect(body.isSuperadmin).toBe(false);
  });
});
