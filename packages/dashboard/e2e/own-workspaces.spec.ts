import { expect, test, type Page } from "@playwright/test";
import { ACCOUNTS, signIn, signInToWorkspace, sidebarIdentity } from "./support";

/**
 * Any user creates team workspaces they own, up to the installation's
 * per-user limit (superadmins have none), and switches between workspaces
 * without signing out.
 *
 * `creator` starts with only its Personal workspace. `admin` (bootstrap
 * superadmin) changes the limit. Each signs in once.
 */
const TEAM_OWNER = "E2E Team — Owner";
const NAME = "Orchester E2E";

async function setLimit(admin: Page, value: number): Promise<void> {
  await admin.goto("/dashboard/installation/settings");
  const field = admin.getByLabel("Workspaces per user", { exact: true });
  if ((await field.inputValue()) === String(value)) return;
  await field.fill(String(value));
  await admin.getByRole("button", { name: "Save settings" }).click();
  await expect(admin.getByRole("status")).toHaveText("Settings saved.");
}

test.describe.serial("own workspaces", () => {
  let user: Page;
  let admin: Page;

  test.beforeAll(async ({ browser }) => {
    user = await (await browser.newContext()).newPage();
    await signIn(user, ACCOUNTS.creator.email, ACCOUNTS.creator.password);
    admin = await (await browser.newContext()).newPage();
    await signInToWorkspace(admin, ACCOUNTS.admin.email, ACCOUNTS.admin.password, TEAM_OWNER);
  });

  test.afterAll(async () => {
    await user?.context().close();
    await admin?.context().close();
  });

  test("a user creates a team workspace and lands in it as its owner", async () => {
    await user
      .getByRole("navigation", { name: "Dashboard" })
      .getByRole("link", { name: "My workspaces" })
      .click();
    await expect(user.getByRole("heading", { name: "The floor plan" })).toBeVisible();
    await expect(user.getByText("You own 0 of 5 allowed.", { exact: false })).toBeVisible();

    await user.getByLabel("Name").fill(NAME);
    await user.getByRole("button", { name: "Create workspace" }).click();
    await expect(user).toHaveURL(/\/dashboard\/?$/);
    const sidebar = sidebarIdentity(user);
    await expect(sidebar.workspace(NAME)).toBeVisible();
    await expect(sidebar.role("Owner")).toBeVisible();

    // A team workspace: Members offers invitations (a personal one would not).
    await user.goto("/dashboard/admin/members");
    await expect(user.getByRole("button", { name: "Create invitation" })).toBeVisible();
  });

  test("switching goes back to the personal workspace without signing out", async () => {
    await user.goto("/dashboard/workspaces");
    const list = user.getByRole("list", { name: "Your workspaces" });
    const personal = list.getByRole("listitem").filter({ hasText: "personal" });
    await personal.getByRole("button", { name: /^Open / }).click();
    await expect(user).toHaveURL(/\/dashboard\/?$/);
    await expect(sidebarIdentity(user).workspace(NAME)).toHaveCount(0);
    await user.goto("/dashboard/workspaces");
    await expect(
      user
        .getByRole("list", { name: "Your workspaces" })
        .getByRole("listitem")
        .filter({ hasText: NAME })
    ).toContainText("Owner");
  });

  test("the per-user limit stops the next workspace", async () => {
    await setLimit(admin, 1);
    try {
      await user.goto("/dashboard/workspaces");
      await expect(user.getByText("You own 1 of 1 allowed.", { exact: false })).toBeVisible();
      await expect(user.getByRole("note")).toContainText("You have reached the limit");
      await expect(user.getByRole("button", { name: "Create workspace" })).toHaveCount(0);
      const res = await user.request.post("/dashboard/api/my-workspaces", {
        data: { name: "One too many" },
      });
      expect(res.status()).toBe(409);
      expect(await res.json()).toEqual({ error: "workspace_limit", limit: 1 });
    } finally {
      await setLimit(admin, 5);
    }
  });
});
