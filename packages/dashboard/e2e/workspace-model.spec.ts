import { expect, test, type Page } from "@playwright/test";
import { ACCOUNTS, signIn, signInToWorkspace, sidebarIdentity } from "./support";

/**
 * Who sets a workspace's LLM model, and what a personal workspace's owner sees.
 *
 * By default only installation admins (superadmins) change the model; a
 * workspace owner sees it read-only and the server refuses their writes. A
 * superadmin can let owners bring their own model in Installation > Settings;
 * then an owner may save one, but never a base URL that is not public https.
 *
 * `modeler` owns only its Personal workspace. `admin` is the bootstrap
 * superadmin and owner of E2E Team. Both sign in once each in this spec.
 */
const TEAM_OWNER = "E2E Team — Owner";
const SETTING = "Workspace owners can set their own model";

async function setOwnersMayChooseModel(admin: Page, on: boolean): Promise<void> {
  await admin.goto("/dashboard/installation/settings");
  const box = admin.getByLabel(SETTING, { exact: true });
  if ((await box.isChecked()) === on) return;
  await box.setChecked(on);
  await admin.getByRole("button", { name: "Save settings" }).click();
  await expect(admin.getByRole("status")).toHaveText("Settings saved.");
}

test.describe.serial("workspace model", () => {
  let owner: Page;
  let admin: Page;

  test.beforeAll(async ({ browser }) => {
    owner = await (await browser.newContext()).newPage();
    await signIn(owner, ACCOUNTS.modeler.email, ACCOUNTS.modeler.password);
    admin = await (await browser.newContext()).newPage();
    await signInToWorkspace(admin, ACCOUNTS.admin.email, ACCOUNTS.admin.password, TEAM_OWNER);
  });

  test.afterAll(async () => {
    await owner?.context().close();
    await admin?.context().close();
  });

  test("a personal workspace's owner: Owner badge, Members explains instead of offering invites", async () => {
    await expect(sidebarIdentity(owner).role("Owner")).toBeVisible();
    await owner.goto("/dashboard/admin/members");
    await expect(owner.getByRole("note")).toContainText("This is your personal workspace");
    await expect(owner.getByRole("button", { name: "Create invitation" })).toHaveCount(0);
    await expect(owner.getByRole("button", { name: /^Leave / })).toHaveCount(0);
    await expect(owner.getByLabel(`Role of ${ACCOUNTS.modeler.email}`)).toHaveCount(0);
  });

  test("by default the owner sees the model read-only and the server refuses changes", async () => {
    await owner.goto("/dashboard/config");
    // Who may change it waits behind the (i) beside "Set by …", as the button's description.
    await expect(
      owner.getByRole("button", { name: "About: Who can change it" })
    ).toHaveAccessibleDescription("Only a superadmin can change it.");
    await expect(owner.getByRole("button", { name: "Save changes" })).toHaveCount(0);
    // A password session has no key prefix to show.
    await expect(owner.getByText("Key prefix")).toHaveCount(0);

    const res = await owner.request.put("/dashboard/api/config/llm", {
      data: { provider: "openai", apiKey: "sk-e2e-not-a-real-key" },
    });
    expect(res.status()).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("LLM_CONFIG_INSTALLATION_ONLY");
  });

  test("a superadmin can edit the model of a workspace they own", async () => {
    await admin.goto("/dashboard/config");
    await expect(admin.getByRole("button", { name: "Save changes" })).toBeVisible();
  });

  test("once allowed, the owner can edit, but a non-public base URL is refused", async () => {
    await setOwnersMayChooseModel(admin, true);
    try {
      await owner.goto("/dashboard/config");
      await expect(owner.getByRole("button", { name: "Save changes" })).toBeVisible();

      // Through the form: an Ollama on the server's own network.
      await owner.getByRole("combobox").first().selectOption("ollama");
      await owner.getByPlaceholder("http://localhost:11434").fill("http://localhost:11434");
      const saved = owner.waitForResponse(
        (r) => r.url().includes("/dashboard/api/config/llm") && r.request().method() === "PUT"
      );
      await owner.getByRole("button", { name: "Save changes" }).click();
      expect((await saved).status()).toBe(422);
      await expect(owner.getByRole("alert").filter({ hasText: "https://" })).toBeVisible();

      // Straight at the API: cloud metadata and a private range.
      for (const [baseUrl, code] of [
        ["https://169.254.169.254/latest", "BASE_URL_PRIVATE_ADDRESS"],
        ["https://10.0.0.8/v1", "BASE_URL_PRIVATE_ADDRESS"],
      ] as const) {
        const res = await owner.request.put("/dashboard/api/config/llm", {
          data: { provider: "openai", apiKey: "sk-e2e-not-a-real-key", baseUrl },
        });
        expect(res.status(), baseUrl).toBe(422);
        expect(((await res.json()) as { code: string }).code).toBe(code);
      }
      // Nothing was stored: the workspace still uses the installation's model.
      const read = (await (await owner.request.get("/dashboard/api/config/llm")).json()) as {
        source: string;
        canEdit: boolean;
      };
      expect(read).toMatchObject({ source: "env", canEdit: true });
    } finally {
      await setOwnersMayChooseModel(admin, false);
    }
  });
});
