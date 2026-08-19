import { test, expect } from "../../support/fixtures";
import { AgentDetailPage } from "../../pages";

test.describe("agent", () => {
  test("create and edit agent details form", async ({ signedIn }) => {
    const detail = new AgentDetailPage(signedIn);
    await detail.goto();

    await expect(detail.nameInput).toBeVisible({ timeout: 15000 });
    await detail.fillAndSave(
      "Test Agent",
      "An automated test agent",
      "Assistant",
      "You are a helpful test agent."
    );

    // Assert redirection to agents list
    await expect(signedIn.locator('[data-testid="agents-title"]')).toBeVisible({ timeout: 15000 });
  });
});
