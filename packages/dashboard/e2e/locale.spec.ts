import { expect, test, type Page } from "@playwright/test";
import { ACCOUNTS } from "./support";

/** Language: the switch, the cookie, no hydration mismatch (console stays clean). */
test("the language switch turns the dashboard Spanish and Account turns it back", async ({
  page,
}) => {
  const errors = collectConsoleErrors(page);
  // `owner` has a single membership, so no workspace picker (itself translated) sits in the way.
  const { email, password } = ACCOUNTS.owner;

  await page.goto("/dashboard/login");
  await page.getByRole("button", { name: "Español" }).click();
  const submit = page.getByRole("button", { name: "Iniciar sesión", exact: true });
  await expect(submit).toBeVisible();

  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await submit.click();
  await expect(page).toHaveURL(/\/dashboard\/?$/);
  const sessions = page.getByRole("link", { name: "Sesiones" });
  await expect(sessions).toBeVisible();

  await page.reload();
  await expect(sessions).toBeVisible();
  expect(errors).toEqual([]);

  await page.goto("/dashboard/account");
  await page.getByRole("radio", { name: "English" }).check();
  await expect(page.getByRole("link", { name: "Sessions" })).toBeVisible();
  expect(errors).toEqual([]);
});

function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}
