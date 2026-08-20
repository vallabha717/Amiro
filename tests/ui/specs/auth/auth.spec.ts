import { test, expect } from "../../support/fixtures";
import { SignInPage } from "../../pages";

test.describe("auth", () => {
  test("sign in with valid credentials and persist session on reload", async ({ amiro, page }) => {
    const signInPage = new SignInPage(page);
    await signInPage.goto();

    await signInPage.signIn(amiro.accounts.user.email, amiro.accounts.user.password);
    await page.waitForURL((url) => !url.pathname.includes("/sign-in"), { timeout: 15000 });

    // Reload page and assert still signed in (not bounced to /sign-in)
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    expect(page.url()).not.toContain("/sign-in");
  });

  test("wrong password triggers error notification", async ({ amiro, page }) => {
    const signInPage = new SignInPage(page);
    await signInPage.goto();

    await signInPage.signIn(amiro.accounts.user.email, "wrong-password-123");

    // Assert error toast is shown
    const toast = page.locator("[data-sonner-toast]").first();
    await expect(toast).toBeVisible({ timeout: 10000 });
  });

  test("protected route redirects unauthenticated user to sign in", async ({ amiro: _amiro, page }) => {
    await page.goto("/admin");
    await page.waitForURL((url) => url.pathname.includes("/sign-in") || url.pathname === "/", { timeout: 15000 });
  });
});
