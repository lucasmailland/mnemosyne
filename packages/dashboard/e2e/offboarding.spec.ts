import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import {
  ACCOUNTS,
  INVALID_LOGIN,
  fillLogin,
  formAlert,
  serverRequest,
  signIn,
  signInToPersonal,
  signInToWorkspace,
  state,
  rowAction,
} from "./support";

/**
 * Disabling and offboarding (accounts stage A, Task 10). The superadmin
 * session is shared by the tests of the group; each target account belongs to
 * this spec alone.
 */
const TEAM_OWNER = "E2E Team — Owner";

test.describe("offboarding", () => {
  test.describe.configure({ mode: "serial" });

  let context: BrowserContext;
  let admin: Page;

  test.beforeAll(async ({ browser }, testInfo) => {
    context = await browser.newContext({ baseURL: testInfo.project.use.baseURL! });
    admin = await context.newPage();
    await signInToWorkspace(admin, ACCOUNTS.admin.email, ACCOUNTS.admin.password, TEAM_OWNER);
  });
  test.afterAll(async () => {
    await context.close();
  });

  const row = (email: string) =>
    admin.getByRole("list", { name: "Users" }).getByRole("listitem").filter({ hasText: email });

  test("a disabled user's open session ends at their next navigation; enabling restores sign-in", async ({
    page,
  }) => {
    const { email, password } = ACCOUNTS.sleeper;
    await signIn(page, email, password);
    await page.goto("/dashboard/browser");
    await expect(page).toHaveURL(/\/dashboard\/browser/);

    await admin.goto("/dashboard/installation/users");
    await rowAction(admin, email, `Disable ${email}`);
    const dialog = admin.getByRole("dialog", { name: `Disable ${email}` });
    await dialog.getByRole("button", { name: "Disable" }).click();
    await expect(dialog).toBeHidden();
    await expect(row(email)).toContainText("Disabled");

    await page.goto("/dashboard/browser");
    await expect(page).toHaveURL(/\/dashboard\/login/);

    await fillLogin(page, email, password);
    await expect(formAlert(page)).toHaveText(INVALID_LOGIN);

    await rowAction(admin, email, `Enable ${email}`);
    await expect(row(email)).toContainText("Active");
    await signIn(page, email, password);
  });

  test("offboarding the last owner asks for a new owner; then the user cannot sign in and their API token is refused", async ({
    page,
  }) => {
    const { email, password } = ACCOUNTS.leaver;
    await signInToPersonal(page, email, password);
    const created = await page.request.post("/dashboard/api/admin/keys", {
      data: { label: "e2e leaver", scopes: ["memory:read"] },
    });
    expect(created.status()).toBe(201);
    const { key } = (await created.json()) as { key: string };
    expect(serverRequest(key, "GET", "/me").status).toBe(200);

    await admin.goto("/dashboard/installation/users");
    await rowAction(admin, email, `Offboard ${email}`);
    const dialog = admin.getByRole("dialog", { name: `Offboard ${email}` });
    await dialog.getByRole("button", { name: "Offboard" }).click();

    const alert = dialog.locator("form").getByRole("alert");
    await expect(alert).toContainText("only owner");
    // APP-058: role="alert" announces it once; it no longer also takes focus.
    await expect(alert).not.toHaveAttribute("aria-live");
    const owner = dialog.getByLabel(`New owner of ${state().leaverTeamName}`);
    await expect(owner).toBeVisible();
    // The person being offboarded and disabled accounts are not offered.
    await expect(owner.locator("option", { hasText: email })).toHaveCount(0);
    await owner.selectOption({ label: ACCOUNTS.heir.email });
    await dialog.getByRole("button", { name: "Offboard" }).click();
    await expect(dialog).toBeHidden();
    await expect(row(email)).toContainText("Disabled");

    await test.step("the heir owns the workspace now", async () => {
      await admin.goto("/dashboard/installation/workspaces");
      const card = admin
        .getByRole("list", { name: "Workspaces" })
        .getByRole("listitem")
        .filter({ hasText: state().leaverTeamName });
      await expect(card).toContainText(ACCOUNTS.heir.email);
      await card.getByRole("button", { name: /^Members of / }).click();
      await expect(card.getByLabel(new RegExp(`Role of ${ACCOUNTS.heir.email}`))).toHaveValue(
        "owner"
      );
      await expect(card.getByText(email)).toHaveCount(0);
    });

    await test.step("the person cannot sign in and the API token is refused", async () => {
      const second = await page.context().browser()!.newContext({
        baseURL: test.info().project.use.baseURL!,
      });
      const sp = await second.newPage();
      await fillLogin(sp, email, password);
      await expect(formAlert(sp)).toHaveText(INVALID_LOGIN);
      await second.close();
      expect(serverRequest(key, "GET", "/me").status).toBe(401);
      // Their open session is gone too.
      await page.goto("/dashboard/browser");
      await expect(page).toHaveURL(/\/dashboard\/login/);
    });
  });
});
