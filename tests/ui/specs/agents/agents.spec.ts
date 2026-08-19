import { test, expect } from "../../support/fixtures";
import { AgentsPage } from "../../pages";

test.describe("agents", () => {
  test("list agents page renders and links to create agent", async ({ signedIn }) => {
    const agents = new AgentsPage(signedIn);
    await agents.goto();

    await expect(signedIn.locator('[data-testid="agents-title"]')).toBeVisible({ timeout: 15000 });
    await expect(agents.createAgentCard).toBeVisible({ timeout: 15000 });
  });
});
