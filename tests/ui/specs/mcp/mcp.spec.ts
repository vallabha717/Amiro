import { test, expect } from "../../support/fixtures";
import { McpPage } from "../../pages";

test.describe("mcp", () => {
  test("mcp dashboard displays server section and add server trigger", async ({ signedIn }) => {
    const mcp = new McpPage(signedIn);
    await mcp.goto();

    await expect(signedIn.locator('[data-testid="mcp-dashboard"]')).toBeVisible({ timeout: 15000 });
    await expect(mcp.addServerButton).toBeVisible({ timeout: 15000 });
  });
});
