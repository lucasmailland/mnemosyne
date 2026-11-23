import { expect, test } from "@playwright/test";
import { ACCOUNTS, signIn, signInToWorkspace, sidebarIdentity, state } from "./support";

/**
 * Members page (accounts stage A). The bootstrap administrator owns E2E Team;
 * `roleChanged` is the member whose role the spec changes, so no other spec's
 * account is touched.
 */
const TEAM_OWNER = "E2E Team — Owner";

test.describe("members", () => {
  test("an owner sees emails and roles, changes a role, and the only owner cannot leave", async ({
    page,
  }) => {
    await signInToWorkspace(page, ACCOUNTS.admin.email, ACCOUNTS.admin.password, TEAM_OWNER);
    await page
      .getByRole("navigation", { name: "Dashboard" })
      .getByRole("link", { name: "Members" })
      .click();
    await expect(page).toHaveURL(/\/dashboard\/admin\/members/);
    await expect(page.getByRole("heading", { name: "The frieze" })).toBeVisible();

    await test.step("emails and roles are listed", async () => {
      await expect(page.getByText(ACCOUNTS.reader.email, { exact: true })).toBeVisible();
      await expect(page.getByLabel(`Role of ${ACCOUNTS.reader.email}`)).toHaveValue("read");
      await expect(page.getByLabel(`Role of ${ACCOUNTS.multi.email}`)).toHaveValue("write");
    });

    await test.step("changing a role persists", async () => {
      const select = page.getByLabel(`Role of ${ACCOUNTS.roleChanged.email}`);
      await expect(select).toHaveValue("read");
      const saved = page.waitForResponse(
        (res) => res.url().includes("/workspace/members/") && res.request().method() === "PATCH"
      );
      await select.selectOption("write");
      expect((await saved).status()).toBe(200);
      await page.reload();
      await expect(page.getByLabel(`Role of ${ACCOUNTS.roleChanged.email}`)).toHaveValue("write");
    });

    await test.step("the only owner gets an explanation instead of Leave and a role select", async () => {
      // The role shows; the explanation waits behind its (i) as the button's description.
      await expect(page.getByRole("button", { name: "About: Owner" })).toHaveAccessibleDescription(
        /you are the only owner/
      );
      await expect(page.getByLabel(`Role of ${ACCOUNTS.admin.email}`)).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: `Actions for ${ACCOUNTS.admin.email}` })
      ).toHaveCount(0);
    });

    await test.step("the server still refuses removing the last owner (409)", async () => {
      const members = (await (
        await page.request.get("/dashboard/api/workspace/members")
      ).json()) as { members: Array<{ userId: string; email: string }> };
      const me = members.members.find((m) => m.email === ACCOUNTS.admin.email)!;
      const res = await page.request.delete(
        `/dashboard/api/workspace/members/${encodeURIComponent(me.userId)}`
      );
      expect(res.status()).toBe(409);
    });
  });

  test("a viewer does not see Members", async ({ page }) => {
    await signIn(page, ACCOUNTS.reader.email, ACCOUNTS.reader.password);
    const sidebar = sidebarIdentity(page);
    await expect(sidebar.role("Viewer")).toBeVisible();
    await expect(sidebar.workspace(state().teamWorkspaceName)).toBeVisible();
    await expect(page.getByRole("link", { name: "Members" })).toHaveCount(0);
    // Opening the address directly explains instead of listing.
    await page.goto("/dashboard/admin/members");
    await expect(
      page.getByText("Members is available to workspace owners and admins.")
    ).toBeVisible();
    await expect(page.getByText(ACCOUNTS.multi.email)).toHaveCount(0);
  });

  test("the page fits a phone without horizontal scrolling", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await signInToWorkspace(page, ACCOUNTS.admin.email, ACCOUNTS.admin.password, TEAM_OWNER);
    await page.goto("/dashboard/admin/members");
    await expect(page.getByLabel(`Role of ${ACCOUNTS.reader.email}`)).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
