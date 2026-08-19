import { test, expect } from "../../support/fixtures";
import { OnboardingPage } from "../../pages";

test.describe("onboarding", () => {
  test("complete first-run flow end-to-end", async ({ amiro, page }) => {
    // Authenticate user session
    await page.addInitScript((token) => {
      window.localStorage.setItem("amiro.session-token", token);
    }, amiro.accounts.user.token);

    const onboarding = new OnboardingPage(page);
    await onboarding.goto();

    await onboarding.selectProvider("openai");
    await onboarding.configure("sk-test-key-12345", "http://127.0.0.1:8787");

    // Completion step
    await expect(page.getByText("You're all set!")).toBeVisible({ timeout: 10000 });
    await onboarding.finish();
    await page.waitForURL((url) => url.pathname === "/", { timeout: 15000 });
  });

  test("skip onboarding navigates directly to chat", async ({ amiro, page }) => {
    await page.addInitScript((token) => {
      window.localStorage.setItem("amiro.session-token", token);
    }, amiro.accounts.user.token);

    const onboarding = new OnboardingPage(page);
    await onboarding.goto();

    await onboarding.skip();
    await page.waitForURL((url) => url.pathname === "/", { timeout: 15000 });
  });
});
