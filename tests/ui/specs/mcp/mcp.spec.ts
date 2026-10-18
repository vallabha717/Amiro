import { test, expect } from "../../support/fixtures";
import { McpPage } from "../../pages";

test.describe("mcp", () => {
  test("custom MCP servers live on the Connectors page", async ({ signedIn }) => {
    const mcp = new McpPage(signedIn);
    await mcp.goto();

    await expect(signedIn.locator('[data-testid="connectors-page"]')).toBeVisible({ timeout: 15000 });
    await expect(mcp.addServerButton).toBeVisible({ timeout: 15000 });
  });
});
