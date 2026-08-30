import { test, expect } from "../../support/fixtures";

// Phase 6 (docs/skills/) decommissioned the agent feature: the create-agent
// entry points went in Phase 5, and the agent detail route itself
// (`/agent`) and the agent list route (`/agents`) are gone as of this
// phase. Both paths now correspond to no static export file at all, so the
// Go static file server (backend-go/internal/web/web.go) answers them the
// same way it answers any other unknown path: a real 404 status with the
// export's own not-found page, not a blank page and not a 200 SPA
// fallback (which would break link checkers and caches, per
// TestHandler_UnknownPathServesTheExports404WithA404Status).
test.describe("agent removal", () => {
  for (const path of ["/agent", "/agents"]) {
    test(`${path} returns the app's not-found handling`, async ({ signedIn }) => {
      const response = await signedIn.goto(path);
      expect(response?.status()).toBe(404);
      await signedIn.waitForLoadState("domcontentloaded");
      await expect(signedIn.locator("body")).toBeVisible({ timeout: 15000 });
    });
  }

  test("no sidebar entry links to /agent or /agents", async ({ signedIn }) => {
    await signedIn.goto("/skills");
    await signedIn.waitForLoadState("domcontentloaded");
    await expect(signedIn.locator('[data-testid="skills-title"]')).toBeVisible({ timeout: 15000 });

    await expect(signedIn.locator('a[href="/agent"]')).toHaveCount(0);
    await expect(signedIn.locator('a[href="/agents"]')).toHaveCount(0);
    await expect(signedIn.locator('a[href^="/agent?"]')).toHaveCount(0);
  });
});
