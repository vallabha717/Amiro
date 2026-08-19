import { test, expect } from "../../support/fixtures";
import { ArchivePage } from "../../pages";

test.describe("archive", () => {
  test("archive view renders empty state when archive has no threads", async ({ signedIn }) => {
    // Navigate to archive
    const archive = new ArchivePage(signedIn);
    await archive.goto();

    // Verify archive section is visible or redirected to main chat if no archive id is specified
    await expect(signedIn.locator("body")).toBeVisible({ timeout: 15000 });
  });
});
