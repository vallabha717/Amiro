import { test, expect } from "../../support/fixtures";
import { OnboardingPage } from "../../pages";

// The owner lands in the wizard until it is finished; every step after the
// account can be skipped, and skipped steps reappear as a sidebar checklist.
test.describe("onboarding", () => {
  test("owner can skip every optional step and land in chat", async ({
    amiro,
    page,
  }) => {
    await page.addInitScript((token) => {
      window.localStorage.setItem("amiro.session-token", token);
    }, amiro.accounts.admin.token);

    const onboarding = new OnboardingPage(page);
    await onboarding.goto();
    await expect(page.getByTestId("onboarding-wizard")).toBeVisible();

    await onboarding.skip();
    await page.waitForURL((url) => url.pathname === "/", { timeout: 15000 });
    await expect(page.getByTestId("setup-checklist")).toBeVisible();
  });

  test("agent name and look are saved", async ({ amiro, page }) => {
    await page.addInitScript((token) => {
      window.localStorage.setItem("amiro.session-token", token);
    }, amiro.accounts.admin.token);

    const onboarding = new OnboardingPage(page);
    await onboarding.goto();
    await page.getByTestId("onboarding-agent-name").fill("Juno");
    await page.getByTestId("onboarding-shape-sprout").click();
    await page.getByTestId("onboarding-color-teal").click();
    await onboarding.agentContinue.click();
    await expect(onboarding.providerSkip).toBeVisible();

    const identity = await page.evaluate(async () => {
      const token = window.localStorage.getItem("amiro.session-token");
      const res = await fetch("/api/agent/identity", {
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Amiro-Token": (window as { __BACKEND_TOKEN__?: string })
            .__BACKEND_TOKEN__ ?? "",
        },
      });
      return res.json();
    });
    expect(identity.name).toBe("Juno");
    expect(identity.traits.bodyShape).toBe("sprout");
    expect(identity.traits.color).toBe("teal");
  });
});
