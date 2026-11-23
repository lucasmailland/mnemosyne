import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import {
  ACCOUNTS,
  INVALID_LOGIN,
  fillLogin,
  formAlert,
  horizontalOverflow,
  serverRequest,
  signIn,
  signInToWorkspace,
  rowAction,
  pickAuditAction,
  setDays,
} from "./support";

/**
 * Installation section (accounts stage A, Task 10). One superadmin session is
 * shared by the tests of the group (the per-email sign-in budget is 10 per 15
 * minutes and `admin` already spends about 6 in the other specs); the specs
 * run in order, and the last one switches that session into another workspace.
 */
const TEAM_OWNER = "E2E Team — Owner";
const NAV = { name: "Dashboard" };

test.describe("installation", () => {
  test.describe.configure({ mode: "serial" });

  let context: BrowserContext;
  let admin: Page;

  test.beforeAll(async ({ browser }, testInfo) => {
    context = await browser.newContext({
      baseURL: testInfo.project.use.baseURL!,
      permissions: ["clipboard-read", "clipboard-write"],
    });
    admin = await context.newPage();
    await signInToWorkspace(admin, ACCOUNTS.admin.email, ACCOUNTS.admin.password, TEAM_OWNER);
  });
  test.afterAll(async () => {
    await context.close();
  });

  const row = (page: Page, email: string) =>
    page.getByRole("list", { name: "Users" }).getByRole("listitem").filter({ hasText: email });

  test("a superadmin sees Installation; an ordinary owner does not and gets 404", async ({
    page,
  }) => {
    const nav = admin.getByRole("navigation", NAV);
    await expect(admin.getByText("Installation", { exact: true })).toBeVisible();
    for (const link of ["Users", "All workspaces", "Settings", "Security audit"])
      await expect(nav.getByRole("link", { name: link, exact: true })).toBeVisible();

    await signIn(page, ACCOUNTS.plain.email, ACCOUNTS.plain.password);
    await expect(page.getByText("Installation", { exact: true })).toHaveCount(0);
    for (const section of ["users", "workspaces", "settings", "audit"]) {
      const response = await page.goto(`/dashboard/installation/${section}`);
      expect(response?.status(), section).toBe(404);
    }
    // The API answers the same way: nothing announces the section.
    expect((await page.request.get("/dashboard/api/instance/users")).status()).toBe(404);
  });

  test("the user list shows status, workspaces and the superadmin badge", async () => {
    await admin.getByRole("link", { name: "Users", exact: true }).click();
    await expect(admin).toHaveURL(/\/dashboard\/installation\/users/);
    await expect(
      admin.getByRole("heading", { name: "The architecture — Users", level: 1 })
    ).toBeVisible();
    await expect(row(admin, ACCOUNTS.admin.email)).toContainText("Superadmin");
    await expect(row(admin, ACCOUNTS.admin.email)).toContainText("(you)");
    await expect(row(admin, ACCOUNTS.reader.email)).toContainText("Active");
    await expect(row(admin, ACCOUNTS.reader.email)).toContainText("E2E Team (Viewer)");
    await expect(row(admin, ACCOUNTS.grantee.email)).not.toContainText("Superadmin");
  });

  test("granting superadmin asks for the password again; the dialog traps focus and Escape closes it", async () => {
    await admin.goto("/dashboard/installation/users");
    const grant = `Grant superadmin to ${ACCOUNTS.grantee.email}`;
    const opener = await rowAction(admin, ACCOUNTS.grantee.email, grant);
    const dialog = admin.getByRole("dialog", {
      name: `Grant superadmin to ${ACCOUNTS.grantee.email}`,
    });
    await expect(dialog).toBeVisible();

    await test.step("focus stays inside the dialog and Escape returns it to the opener", async () => {
      for (let i = 0; i < 6; i++) {
        await admin.keyboard.press("Tab");
        expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
      }
      await admin.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(opener).toBeFocused();
    });

    await test.step("a wrong password is a focused error inside the form", async () => {
      await rowAction(admin, ACCOUNTS.grantee.email, grant);
      await dialog.getByLabel("Your password").fill("not my password");
      await dialog.getByRole("button", { name: "Grant superadmin" }).click();
      const alert = dialog.locator("form").getByRole("alert");
      await expect(alert).toHaveText("That password is not correct.");
      await expect(alert).toBeFocused();
      await expect(row(admin, ACCOUNTS.grantee.email)).not.toContainText("Superadmin");
    });

    await test.step("the right password grants it", async () => {
      await dialog.getByLabel("Your password").fill(ACCOUNTS.admin.password);
      await dialog.getByRole("button", { name: "Grant superadmin" }).click();
      await expect(dialog).toBeHidden();
      await expect(row(admin, ACCOUNTS.grantee.email)).toContainText("Superadmin");
    });
  });

  test("revoking works until the last superadmin, whose revocation shows the message", async () => {
    await admin.goto("/dashboard/installation/users");
    await rowAction(
      admin,
      ACCOUNTS.grantee.email,
      `Revoke superadmin from ${ACCOUNTS.grantee.email}`
    );
    let dialog = admin.getByRole("dialog");
    await dialog.getByLabel("Your password").fill(ACCOUNTS.admin.password);
    await dialog.getByRole("button", { name: "Revoke superadmin" }).click();
    await expect(dialog).toBeHidden();
    await expect(row(admin, ACCOUNTS.grantee.email)).not.toContainText("Superadmin");

    // Only the bootstrap administrator is left.
    await rowAction(admin, ACCOUNTS.admin.email, `Revoke superadmin from ${ACCOUNTS.admin.email}`);
    dialog = admin.getByRole("dialog");
    await dialog.getByLabel("Your password").fill(ACCOUNTS.admin.password);
    await dialog.getByRole("button", { name: "Revoke superadmin" }).click();
    const alert = dialog.locator("form").getByRole("alert");
    await expect(alert).toContainText("last active superadmin");
    await expect(alert).toBeFocused();
    await admin.keyboard.press("Escape");
    await expect(row(admin, ACCOUNTS.admin.email)).toContainText("Superadmin");
  });

  test("the audit lists the grant; filters by action and day (the end day is inclusive); pages", async () => {
    // Enough entries for a second page: clearing an unset URL is audited too.
    for (let i = 0; i < 55; i++) {
      const res = await admin.request.put("/dashboard/api/instance/settings", {
        data: { publicBaseUrl: null },
      });
      expect(res.status()).toBe(200);
    }
    await admin.goto("/dashboard/installation/audit");
    const entries = admin.getByRole("list", { name: "Audit entries" }).getByRole("listitem");
    await expect(entries).toHaveCount(50);

    await test.step("filter by action", async () => {
      await pickAuditAction(admin, "superadmin_granted");
      await expect(admin).toHaveURL(/action=superadmin_granted/);
      await expect(entries.first()).toContainText("superadmin_granted");
      await expect(entries.first()).toContainText(ACCOUNTS.admin.email);
      expect(await entries.count()).toBeGreaterThanOrEqual(1);
      expect(await entries.filter({ hasNotText: "superadmin_granted" }).count()).toBe(0);
    });

    await test.step("a picked end day includes that whole day (UTC)", async () => {
      const today = new Date().toISOString().slice(0, 10);
      await setDays(admin, today, today);
      await expect(admin).toHaveURL(new RegExp(`to=${today}`));
      await expect(entries.first()).toContainText("superadmin_granted");
      const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
      await setDays(admin, tomorrow, "");
      await expect(admin.getByText("No entries match.")).toBeVisible();
    });

    await test.step("pagination follows the cursor and goes back to the newest", async () => {
      await admin.getByRole("link", { name: "Clear filters" }).click();
      await expect(admin.getByLabel("From", { exact: true })).toHaveValue("");
      await pickAuditAction(admin, "settings_changed");
      await expect(admin).toHaveURL(/action=settings_changed/);
      await expect(entries).toHaveCount(50);
      await admin.getByRole("link", { name: "Older entries" }).click();
      await expect(admin).toHaveURL(/cursor=/);
      expect(await entries.count()).toBeGreaterThanOrEqual(5);
      await expect(admin.getByRole("link", { name: "Newest entries" })).toBeVisible();
      await admin.getByRole("link", { name: "Newest entries" }).click();
      await expect(admin).not.toHaveURL(/cursor=/);
    });
  });

  test("settings: a change shows source: global; clearing it goes back to the environment", async () => {
    await admin.goto("/dashboard/installation/settings");
    await expect(admin.getByText("Closed until email delivery is configured")).toBeVisible();
    const field = admin.getByLabel("Public base URL", { exact: true });
    const urlSource = admin.getByText(/^source: /).nth(1);
    await expect(urlSource).toHaveText("source: env");
    await expect(admin.getByRole("button", { name: "Save settings" })).toBeDisabled();

    await test.step("an address the server refuses is a focused error", async () => {
      await field.fill("http://example.com");
      await admin.getByRole("button", { name: "Save settings" }).click();
      const alert = formAlert(admin);
      await expect(alert).toContainText("https://");
      await expect(alert).toBeFocused();
    });

    await test.step("a valid address is saved and labelled global", async () => {
      await field.fill("https://mnemosyne.e2e.test/");
      await admin.getByRole("button", { name: "Save settings" }).click();
      await expect(admin.getByRole("status")).toHaveText("Settings saved.");
      await expect(field).toHaveValue("https://mnemosyne.e2e.test");
      await expect(urlSource).toHaveText("source: global");
      await admin.reload();
      await expect(admin.getByLabel("Public base URL", { exact: true })).toHaveValue(
        "https://mnemosyne.e2e.test"
      );
    });

    await test.step("the invitations switch is saved and restored", async () => {
      const toggle = admin.getByLabel("Workspace invitations enabled", { exact: true });
      await toggle.uncheck();
      await admin.getByRole("button", { name: "Save settings" }).click();
      await expect(admin.getByRole("status")).toHaveText("Settings saved.");
      await admin.reload();
      await expect(
        admin.getByLabel("Workspace invitations enabled", { exact: true })
      ).not.toBeChecked();
      await admin.getByLabel("Workspace invitations enabled", { exact: true }).check();
      await admin.getByRole("button", { name: "Save settings" }).click();
      await expect(admin.getByRole("status")).toHaveText("Settings saved.");
    });

    await test.step("clearing the address returns to the environment value", async () => {
      await admin.getByLabel("Public base URL", { exact: true }).fill("");
      await admin.getByRole("button", { name: "Save settings" }).click();
      await expect(admin.getByRole("status")).toHaveText("Settings saved.");
      await expect(admin.getByText(/^source: /).nth(1)).toHaveText("source: env");
      await expect(admin.getByLabel("Public base URL", { exact: true })).toHaveValue(
        new URL(test.info().project.use.baseURL!).origin
      );
    });
  });

  test("create user: the setup link is shown once and the person sets a password and signs in", async ({
    browser,
  }) => {
    const email = "newcomer@e2e.test";
    const password = "newcomer e2e password";
    await admin.goto("/dashboard/installation/users");
    await admin.getByRole("button", { name: "Create user" }).click();
    const dialog = admin.getByRole("dialog", { name: "Create user" });
    await dialog.getByLabel("Email").fill(email);
    await dialog.getByLabel("Name (optional)").fill("New Comer");
    await dialog.getByRole("button", { name: "Create user" }).click();

    const field = admin.getByLabel(`Account setup link for ${email}`);
    await expect(field).toBeVisible();
    await expect(field).toHaveJSProperty("readOnly", true);
    await expect(admin.getByText(`Shown once. Share it only with ${email}.`)).toBeVisible();
    const link = await field.inputValue();
    expect(new URL(link).pathname).toMatch(/^\/dashboard\/link\/[A-Za-z0-9_-]+$/);
    await admin.getByRole("button", { name: "Copy" }).click();
    expect(await admin.evaluate(() => navigator.clipboard.readText())).toBe(link);
    await admin.getByRole("button", { name: "Done" }).click();
    // The account exists only once the person has used the link.
    await expect(row(admin, email)).toHaveCount(0);

    // The person opens the link in a browser of their own.
    const stranger = await browser.newContext({ baseURL: test.info().project.use.baseURL! });
    const sp = await stranger.newPage();
    await sp.goto(link);
    await expect(
      sp.getByText("Choose a password to finish setting up your account.")
    ).toBeVisible();
    await sp.getByLabel("Password").fill(password);
    await sp.getByRole("button", { name: "Create account" }).click();
    await expect(sp).not.toHaveURL(/\/link\//);
    await stranger.close();

    // They can now sign in on their own, and the link is spent.
    const signedIn = await browser.newContext({ baseURL: test.info().project.use.baseURL! });
    const ip = await signedIn.newPage();
    await signIn(ip, email, password);
    await expect(ip.getByText("Installation", { exact: true })).toHaveCount(0);
    await signedIn.close();
    const again = await browser.newContext({ baseURL: test.info().project.use.baseURL! });
    const ap = await again.newPage();
    await ap.goto(link);
    await expect(ap.getByText("This link is no longer valid. Ask for a new one.")).toBeVisible();
    await again.close();

    await admin.goto("/dashboard/installation/users");
    await expect(row(admin, email)).toContainText("New Comer");

    // Creating the same account twice is refused.
    await admin.getByRole("button", { name: "Create user" }).click();
    const second = admin.getByRole("dialog", { name: "Create user" });
    await second.getByLabel("Email").fill(email);
    await second.getByRole("button", { name: "Create user" }).click();
    await expect(second.locator("form").getByRole("alert")).toContainText("already exists");
    await admin.keyboard.press("Escape");
  });

  test("reset link: the old password stops working and the new one works", async ({ browser }) => {
    const { email, password } = ACCOUNTS.forgetful;
    const fresh = "forgetful new e2e password";
    await admin.goto("/dashboard/installation/users");
    await rowAction(admin, email, `Reset link for ${email}`);
    const field = admin.getByLabel(`Password reset link for ${email}`);
    await expect(field).toBeVisible();
    await expect(admin.getByText(`Shown once. Share it only with ${email}.`)).toBeVisible();
    const link = await field.inputValue();
    await admin.getByRole("button", { name: "Done" }).click();

    const stranger = await browser.newContext({ baseURL: test.info().project.use.baseURL! });
    const sp = await stranger.newPage();
    await sp.goto(link);
    await expect(sp.getByText("Choose a new password.")).toBeVisible();
    await sp.getByLabel("New password").fill(fresh);
    await sp.getByRole("button", { name: "Set new password" }).click();
    await expect(sp).not.toHaveURL(/\/link\//);
    await stranger.close();

    const login = await browser.newContext({ baseURL: test.info().project.use.baseURL! });
    const lp = await login.newPage();
    await fillLogin(lp, email, password);
    await expect(formAlert(lp)).toHaveText(INVALID_LOGIN);
    await signIn(lp, email, fresh);
    await login.close();
  });

  test("a superadmin manages members of a workspace they do not belong to", async () => {
    await admin.goto("/dashboard/installation/workspaces");
    const card = admin
      .getByRole("list", { name: "Workspaces" })
      .getByRole("listitem")
      .filter({ hasText: "Managed Team" });
    await card.getByRole("button", { name: "Members of Managed Team" }).click();
    const heirRole = card.getByLabel(`Role of ${ACCOUNTS.heir.email} in Managed Team`);
    const ownerRole = card.getByLabel(`Role of ${ACCOUNTS.grantee.email} in Managed Team`);
    await expect(heirRole).toHaveValue("read");

    await test.step("changing a role persists", async () => {
      const saved = admin.waitForResponse(
        (res) => res.url().includes("/instance/workspaces/") && res.request().method() === "PATCH"
      );
      await heirRole.selectOption("write");
      expect((await saved).status()).toBe(200);
      await admin.reload();
      await card.getByRole("button", { name: "Members of Managed Team" }).click();
      await expect(heirRole).toHaveValue("write");
    });

    await test.step("the last owner cannot be demoted or removed", async () => {
      await ownerRole.selectOption("read");
      await expect(card.getByRole("alert")).toContainText("at least one owner");
      await admin.reload();
      await card.getByRole("button", { name: "Members of Managed Team" }).click();
      await expect(ownerRole).toHaveValue("owner");

      const opener = card.getByRole("button", {
        name: `Remove ${ACCOUNTS.grantee.email} from Managed Team`,
      });
      await opener.click();
      const dialog = admin.getByRole("dialog", { name: `Remove ${ACCOUNTS.grantee.email}` });
      await dialog.getByRole("button", { name: "Remove member" }).click();
      const alert = dialog.locator("form").getByRole("alert");
      await expect(alert).toContainText("at least one owner");
      await expect(alert).toBeFocused();
      await admin.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(opener).toBeFocused();
      await expect(ownerRole).toBeVisible();
    });

    await test.step("removing a member asks first and then removes them", async () => {
      const opener = card.getByRole("button", {
        name: `Remove ${ACCOUNTS.heir.email} from Managed Team`,
      });
      await opener.click();
      const dialog = admin.getByRole("dialog", { name: `Remove ${ACCOUNTS.heir.email}` });
      await admin.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(heirRole).toBeVisible();
      await opener.click();
      await dialog.getByRole("button", { name: "Remove member" }).click();
      await expect(dialog).toBeHidden();
      await expect(heirRole).toHaveCount(0);
      await expect(ownerRole).toBeVisible();
    });
  });

  const orphanRow = (page: Page) =>
    page
      .getByRole("list", { name: "Workspaces" })
      .getByRole("listitem")
      .filter({ has: page.getByText("Orphan Team", { exact: true }) });

  test("the installation list is All workspaces, and My workspaces points a superadmin to it", async () => {
    await admin.goto("/dashboard/workspaces");
    await expect(admin.getByRole("heading", { name: "The floor plan" })).toBeVisible();
    await admin.getByRole("button", { name: "About: Your workspaces" }).click();
    await admin.getByRole("main").getByRole("link", { name: "All workspaces" }).click();
    await expect(admin).toHaveURL(/\/dashboard\/installation\/workspaces$/);
    await expect(
      admin.getByRole("heading", { name: "The architecture — All workspaces" })
    ).toBeVisible();
    await expect(
      admin.getByRole("navigation", NAV).getByRole("link", { name: "All workspaces", exact: true })
    ).toBeVisible();
  });

  test("a superadmin adds an owner to a workspace that has none", async () => {
    await admin.goto("/dashboard/installation/workspaces");
    const row = orphanRow(admin);
    await expect(row).toContainText("0 members · owners: none");
    await expect(row).toContainText("Nobody can manage this workspace until it has an owner.");

    await row.getByRole("button", { name: "Members of Orphan Team" }).click();
    await expect(row.getByText("No members yet.")).toBeVisible();
    const form = row.getByRole("form", { name: "Add a member to Orphan Team" });
    // With no owner yet, the role starts at Owner.
    await expect(form.getByLabel("Role")).toHaveValue("owner");
    await form.getByLabel("Email").fill(ACCOUNTS.adopter.email);
    await form.getByRole("button", { name: "Add member" }).click();

    await expect(row.getByRole("list", { name: "Members of Orphan Team" })).toContainText(
      ACCOUNTS.adopter.email
    );
    await expect(row).toContainText(`1 member · owner: ${ACCOUNTS.adopter.email}`);
    await expect(row).not.toContainText("Nobody can manage this workspace");

    // Twice is refused with a reason, and an unknown email too.
    await form.getByLabel("Email").fill(ACCOUNTS.adopter.email);
    await form.getByRole("button", { name: "Add member" }).click();
    await expect(form.getByRole("alert")).toHaveText(
      "That person already belongs to this workspace. Change their role above."
    );
    await form.getByLabel("Email").fill("nobody@e2e.test");
    await form.getByRole("button", { name: "Add member" }).click();
    await expect(form.getByRole("alert")).toHaveText(
      "There is no account with that email. Create it in Users first."
    );
  });

  test("a personal workspace offers no way to add members", async () => {
    await admin.goto("/dashboard/installation/workspaces");
    const personal = admin
      .getByRole("list", { name: "Workspaces" })
      .getByRole("listitem")
      .filter({ hasText: `owner: ${ACCOUNTS.owner.email}` });
    await personal.getByRole("button", { name: /^Members of / }).click();
    await expect(personal.getByRole("list", { name: /^Members of / })).toBeVisible();
    await expect(personal.getByRole("form")).toHaveCount(0);
  });

  test("pages use the full width of a wide window", async () => {
    await admin.setViewportSize({ width: 1800, height: 900 });
    for (const path of [
      "/dashboard/installation/workspaces",
      "/dashboard/workspaces",
      "/dashboard/admin/members",
    ]) {
      await admin.goto(path);
      const { main, content } = await admin.evaluate(() => {
        const m = document.querySelector("main")!;
        const style = getComputedStyle(m);
        const inner =
          m.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
        // The page's own wrapper: main's last child (a status banner may come first).
        const page = m.lastElementChild as HTMLElement;
        return { main: inner, content: page.getBoundingClientRect().width };
      });
      expect(content, path).toBeGreaterThanOrEqual(main - 1);
    }
    await admin.setViewportSize({ width: 1280, height: 720 });
  });

  test("the new owner manages the workspace: Members offers invitations", async ({ page }) => {
    await signInToWorkspace(
      page,
      ACCOUNTS.adopter.email,
      ACCOUNTS.adopter.password,
      "Orphan Team — Owner"
    );
    await page.goto("/dashboard/admin/members");
    await expect(page.getByRole("button", { name: "Create invitation" })).toBeVisible();
  });

  test("Installation pages fit a phone without horizontal scrolling", async () => {
    await admin.setViewportSize({ width: 375, height: 800 });
    for (const section of ["users", "workspaces", "settings", "audit"]) {
      await admin.goto(`/dashboard/installation/${section}`);
      await expect(admin.getByRole("heading", { level: 1 })).toBeVisible();
      expect(await horizontalOverflow(admin), section).toBeLessThanOrEqual(0);
    }
    // And with a dialog open.
    await admin.goto("/dashboard/installation/users");
    await admin.getByRole("button", { name: "Create user" }).click();
    await expect(admin.getByRole("dialog")).toBeVisible();
    expect(await horizontalOverflow(admin)).toBeLessThanOrEqual(0);
    await admin.keyboard.press("Escape");
    await admin.setViewportSize({ width: 1280, height: 720 });
  });

  test("open a personal workspace: its facts are readable, write controls are hidden", async ({
    page,
  }) => {
    // The vault owner stores one fact with an API key of their own.
    await signIn(page, ACCOUNTS.vault.email, ACCOUNTS.vault.password);
    const created = await page.request.post("/dashboard/api/admin/keys", {
      data: { label: "e2e vault", scopes: ["memory:read", "memory:write"] },
    });
    expect(created.status()).toBe(201);
    const { key } = (await created.json()) as { key: string };
    const statement = "The vault holds one e2e fact about quokkas.";
    expect(serverRequest(key, "POST", "/remember", { statement }).status).toBe(201);

    await admin.goto("/dashboard/installation/workspaces");
    const workspaces = admin.getByRole("list", { name: "Workspaces" });
    const card = workspaces.getByRole("listitem").filter({ hasText: ACCOUNTS.vault.email });
    await expect(card).toContainText("Personal");

    await test.step("member drill-down", async () => {
      await card.getByRole("button", { name: /^Members of / }).click();
      await expect(
        card.getByLabel(`Role of ${ACCOUNTS.vault.email} in`, { exact: false })
      ).toHaveValue("owner");
    });

    await test.step("Open switches the session, read-only, with a banner", async () => {
      await card.getByRole("button", { name: /^Actions for / }).click();
      await card.getByRole("menuitem", { name: /^Open / }).click();
      await expect(admin).toHaveURL(/\/dashboard\/?$/);
      await expect(
        admin.getByRole("status").filter({ hasText: "Viewing as superadmin, read-only" })
      ).toBeVisible();
      const nav = admin.getByRole("navigation", NAV);
      await expect(admin.locator("aside").getByText("Viewer", { exact: true })).toBeVisible();
      // No Admin group (Members, Keys, ...): nothing to write with.
      for (const hidden of ["Members", "Keys", "Health"])
        await expect(nav.getByRole("link", { name: hidden, exact: true })).toHaveCount(0);
      await expect(nav.getByRole("link", { name: "Users" })).toBeVisible();
      await admin.goto("/dashboard/browser");
      await expect(admin.getByText(statement)).toBeVisible();
    });

    await test.step("the switch is audited", async () => {
      await admin.goto("/dashboard/installation/audit");
      await pickAuditAction(admin, "workspace_opened");
      await expect(admin).toHaveURL(/action=workspace_opened/);
      await expect(
        admin.getByRole("list", { name: "Audit entries" }).getByRole("listitem").first()
      ).toContainText("workspace_opened");
    });
  });
});
