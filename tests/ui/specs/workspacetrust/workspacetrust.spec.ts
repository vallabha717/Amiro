import type { Page } from "@playwright/test";
import { UserSettingsPage } from "../../pages";
import { expect, test } from "../../support/fixtures";

// Sets the persisted project directory before the app's first paint, the
// same way the app itself would after a real folder pick -- there is no
// way to drive the browser's native showDirectoryPicker()/webkitdirectory
// from Playwright, so this pokes zustand-persist's own storage key
// directly. root must be a real directory the backend under test can
// resolve; amiro.home (distinct from amiro.workspace, the one root this
// backend auto-grants) is exactly that.
function setPersistedProjectDirectory(page: Page, root: string) {
  return page.addInitScript((dir) => {
    try {
      window.localStorage?.setItem(
        "mc-app-store-v2.0.1",
        JSON.stringify({ state: { projectDirectory: dir }, version: 0 }),
      );
    } catch {}
  }, root);
}

function signIn(page: Page, token: string) {
  return page.addInitScript((t) => {
    try {
      window.localStorage?.setItem("amiro.session-token", t);
    } catch {}
  }, token);
}

test.describe("workspace trust", () => {
  test("prompts for an ungranted project directory and grants it", async ({
    amiro,
    page,
  }) => {
    await signIn(page, amiro.accounts.user.token);
    await setPersistedProjectDirectory(page, amiro.home);
    await page.goto("/");

    const prompt = page.locator('[data-testid="workspace-trust-prompt"]');
    await expect(prompt).toBeVisible({ timeout: 15000 });
    await expect(
      page.locator('[data-testid="workspace-trust-prompt-root"]'),
    ).toContainText(amiro.home);

    await page.locator('[data-testid="workspace-trust-grant"]').click();
    await expect(prompt).toBeHidden({ timeout: 15000 });

    // A reload must not show it again -- the grant is a database row now,
    // not a per-session decision.
    await page.reload();
    await expect(prompt).toBeHidden({ timeout: 15000 });
  });

  test("declining leaves the project selected but ungranted", async ({
    amiro,
    page,
  }) => {
    await signIn(page, amiro.accounts.user.token);
    await setPersistedProjectDirectory(page, amiro.home);
    await page.goto("/");

    const prompt = page.locator('[data-testid="workspace-trust-prompt"]');
    await expect(prompt).toBeVisible({ timeout: 15000 });
    await page.locator('[data-testid="workspace-trust-decline"]').click();
    await expect(prompt).toBeHidden({ timeout: 15000 });

    const settings = new UserSettingsPage(page);
    await settings.open();
    await expect(settings.grantRow(amiro.home)).toHaveCount(0);
  });

  test("settings lists a granted root and revoke removes it", async ({
    amiro,
    page,
  }) => {
    await signIn(page, amiro.accounts.user.token);

    // Grant directly through the API this time -- the other two tests
    // already cover the prompt's own grant path.
    await page.goto("/");
    await page.evaluate(
      async ({ root, token }) => {
        await fetch("/api/workspace-trust/grant", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ root }),
        });
      },
      { root: amiro.home, token: amiro.accounts.user.token },
    );

    const settings = new UserSettingsPage(page);
    await settings.open();

    await expect(settings.grantRow(amiro.home)).toBeVisible({
      timeout: 15000,
    });

    await settings.revokeButtonFor(amiro.home).click();
    await expect(settings.grantRow(amiro.home)).toHaveCount(0);
  });
});
