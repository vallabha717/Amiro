import { test, expect } from "../../support/fixtures";
import { ChatPage } from "../../pages";

test.describe("store", () => {
  test("client application store initializes and opens model selection", async ({ signedIn }) => {
    const chat = new ChatPage(signedIn);
    await expect(chat.input.first()).toBeVisible({ timeout: 15000 });

    // Verify model selector button is available and opens the popover.
    await expect(chat.modelSelector).toBeVisible({ timeout: 10000 });
    await chat.modelSelector.click();
    const popover = signedIn.locator('[data-testid="model-selector-popover"]');
    await expect(popover).toBeVisible({ timeout: 10000 });
  });
});
