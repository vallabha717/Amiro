import { test, expect } from "../../support/fixtures";
import { SignInPage } from "../../pages";

test.describe("a11y", () => {
  test("keyboard navigation focus moves cleanly through sign-in inputs", async ({ page, amiro: _amiro }) => {
    const signIn = new SignInPage(page);
    await signIn.goto();

    await signIn.emailInput.focus();
    await expect(signIn.emailInput).toBeFocused();

    await page.keyboard.press("Tab");
    await expect(signIn.passwordInput).toBeFocused();

    await page.keyboard.press("Tab");
    await expect(signIn.submitButton).toBeFocused();
  });
});
