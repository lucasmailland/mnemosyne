import { expect, test } from "@playwright/test";
import { ACCOUNTS, INVALID_LOGIN, fillLogin, formAlert, signIn } from "./support";

/** My account: password change (spec §2.3; AUTH-08, AUTH-16). */
test("AUTH-08/16 change password: errors replace each other, success takes effect at login", async ({
  page,
}) => {
  const { email, password } = ACCOUNTS.changer;
  const replacement = "changer replacement password";

  await signIn(page, email, password);
  await page.getByRole("link", { name: "My account" }).click();
  await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();

  const current = page.getByLabel("Current password");
  const next = page.getByLabel("New password");
  const submit = page.getByRole("button", { name: "Change password" });

  // Wrong current password: rejected by the server.
  await current.fill("not my current password");
  await next.fill(replacement);
  await submit.click();
  const wrongCurrent = page.getByText(
    "Could not verify your current password. Try again later, or sign in again."
  );
  await expect(wrongCurrent).toBeVisible();

  // A too-short replacement: only the policy error shows, the stale one is gone.
  await current.fill(password);
  await next.fill("short");
  await submit.click();
  await expect(page.getByText("New password must contain at least 12 characters.")).toBeVisible();
  await expect(wrongCurrent).toHaveCount(0);

  // Valid change.
  await next.fill(replacement);
  await submit.click();
  await expect(page.getByRole("status")).toHaveText("Password changed.");
  await expect(current).toHaveValue("");
  await expect(next).toHaveValue("");

  // The old password no longer works; the new one does.
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/dashboard\/login/);
  await fillLogin(page, email, password);
  await expect(formAlert(page)).toHaveText(INVALID_LOGIN);
  await signIn(page, email, replacement);
});
