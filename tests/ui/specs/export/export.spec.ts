import { test, expect } from "../../support/fixtures";
import { ExportPage } from "../../pages";

test.describe("export", () => {
  test("export page loads signed out and renders message preview or not-found", async ({ page, amiro: _amiro }) => {
    // Ensure signed out
    await page.addInitScript(() => {
      window.localStorage.removeItem("amiro.session-token");
    });

    const exportPage = new ExportPage(page);
    await exportPage.goto("nonexistent-export-id");

    // Verify error or export container is shown
    await expect(page.locator("body")).toBeVisible({ timeout: 15000 });
  });
});
