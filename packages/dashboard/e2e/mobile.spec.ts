import { expect, test } from "@playwright/test";
import { ACCOUNTS, signIn } from "./support";

/** Narrow viewport navigation (AUTH-15): an in-flow disclosure menu. */
test("AUTH-15 the mobile menu opens, closes with Escape and returns focus", async ({ page }) => {
  await signIn(page, ACCOUNTS.owner.email, ACCOUNTS.owner.password);

  const menu = page.getByRole("button", { name: "Menu" });
  const navigation = page.getByRole("navigation", { name: "Dashboard" });
  await expect(menu).toHaveAttribute("aria-expanded", "false");
  await expect(navigation).toBeHidden();

  await menu.click();
  const close = page.getByRole("button", { name: "Close menu" });
  await expect(close).toHaveAttribute("aria-expanded", "true");
  await expect(navigation).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Menu" })).toBeFocused();
  await expect(navigation).toBeHidden();

  // Following a link closes the menu as well.
  await page.getByRole("button", { name: "Menu" }).click();
  // My account now sits in the drawer's footer, outside the primary navigation.
  await page.locator("aside").getByRole("link", { name: "My account" }).click();
  await expect(page).toHaveURL(/\/dashboard\/account/);
  await expect(navigation).toBeHidden();

  // No horizontal overflow at this width.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
