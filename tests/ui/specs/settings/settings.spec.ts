import { test, expect } from "../../support/fixtures";
import { SettingsPage, UserSettingsPage } from "../../pages";

test.describe("settings", () => {
  test("user settings popup opens and displays profile configuration", async ({ signedIn }) => {
    const settings = new SettingsPage(signedIn);
    await settings.open();

    await expect(settings.content).toBeVisible({ timeout: 15000 });
    await expect(settings.nameInput).toBeVisible();
  });
});

// GitHub connect/disconnect (docs/coding-agent-parity/
// 04-git-remote-operations.md): a token controls write access to a user's
// repositories, so it gets its own card, its own status badge, and its own
// connect/disconnect flow -- distinct from the AI provider-key form.
test.describe("github connect", () => {
  test("shows not connected, connects a token, then disconnects it", async ({
    signedIn,
  }) => {
    const settings = new UserSettingsPage(signedIn);
    await settings.open();

    await expect(settings.githubCard).toBeVisible({ timeout: 15000 });
    await expect(settings.githubStatusBadge).toHaveText(/not connected/i);

    await settings.githubTokenInput.fill("ghp_e2e_test_token");
    await settings.githubConnectButton.click();

    await expect(settings.githubStatusBadge).toHaveText(/connected/i, {
      timeout: 15000,
    });
    await expect(settings.githubTokenInput).toHaveCount(0);

    // A reload must not lose the connection -- it is a stored token, not
    // per-session UI state.
    await settings.page.reload();
    await settings.open();
    await expect(settings.githubStatusBadge).toHaveText(/connected/i, {
      timeout: 15000,
    });

    await settings.githubDisconnectButton.click();
    await expect(settings.githubStatusBadge).toHaveText(/not connected/i, {
      timeout: 15000,
    });
  });

  test("never echoes the raw token back in a network response", async ({
    signedIn,
  }) => {
    const settings = new UserSettingsPage(signedIn);
    await settings.open();

    const token = "ghp_should_never_be_echoed_back";
    const responseBodies: string[] = [];
    settings.page.on("response", async (res) => {
      if (res.url().includes("/api/github/")) {
        try {
          responseBodies.push(await res.text());
        } catch {
          // A response Playwright can't read (e.g. already consumed) has
          // nothing to check -- not a reason to fail the test.
        }
      }
    });

    await settings.githubTokenInput.fill(token);
    await settings.githubConnectButton.click();
    await expect(settings.githubStatusBadge).toHaveText(/connected/i, {
      timeout: 15000,
    });

    for (const body of responseBodies) {
      expect(body).not.toContain(token);
    }
  });
});
