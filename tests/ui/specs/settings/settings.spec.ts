import { test, expect } from "../../support/fixtures";
import { SettingsPage } from "../../pages";

test.describe("settings", () => {
  test("user settings popup opens and displays profile configuration", async ({ signedIn }) => {
    const settings = new SettingsPage(signedIn);
    await settings.open();

    await expect(settings.content).toBeVisible({ timeout: 15000 });
    await expect(settings.nameInput).toBeVisible();
  });
});
