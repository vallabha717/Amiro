import { test, expect } from "../../support/fixtures";

test.describe("responsive", () => {
  test("mobile viewport renders responsive layout", async ({ page, amiro }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto("/sign-in");
    await page.waitForLoadState("domcontentloaded");

    await expect(page.locator('[data-testid="signin-submit-button"]')).toBeVisible({ timeout: 15000 });
  });

  test("tablet viewport renders properly", async ({ page, amiro }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto("/sign-in");
    await page.waitForLoadState("domcontentloaded");

    await expect(page.locator('[data-testid="signin-submit-button"]')).toBeVisible({ timeout: 15000 });
  });
});
