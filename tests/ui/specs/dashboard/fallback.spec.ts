import { test, expect } from "../../support/fixtures";

test.describe("dashboard", () => {
  test("deep links load on hard refresh verifying SPA fallback", async ({ signedIn }) => {
    // Navigate directly to deep link /skills (was /agents -- removed in
    // Phase 5, see docs/skills/phases/phase-05-skills-ui.md)
    await signedIn.goto("/skills");
    await signedIn.waitForLoadState("domcontentloaded");
    await expect(signedIn.locator('[data-testid="skills-title"]')).toBeVisible({ timeout: 15000 });

    // Hard reload
    await signedIn.reload();
    await signedIn.waitForLoadState("domcontentloaded");
    await expect(signedIn.locator('[data-testid="skills-title"]')).toBeVisible({ timeout: 15000 });

    // Navigate to /mcp
    await signedIn.goto("/mcp");
    await signedIn.waitForLoadState("domcontentloaded");
    await expect(signedIn.locator('[data-testid="mcp-dashboard"]')).toBeVisible({ timeout: 15000 });

    // Hard reload on /mcp
    await signedIn.reload();
    await signedIn.waitForLoadState("domcontentloaded");
    await expect(signedIn.locator('[data-testid="mcp-dashboard"]')).toBeVisible({ timeout: 15000 });
  });
});
