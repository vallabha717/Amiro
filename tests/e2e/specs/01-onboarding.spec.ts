/**
 * Journey 1 — first run. A brand-new Amiro: welcome → account → agent →
 * brain → ready → home. The provider is deliberately skipped here; journey 2
 * connects it through Admin, the way the user asked to test it.
 */
import { ensureSignedIn, expect, saveAuth, test } from "../support/fixtures";

test.describe("onboarding", () => {
  test("first run: create the owner, name the agent, skip the brain, land in chat", async ({ page, step, note, amiro }) => {
    const { owner, agent } = amiro.cfg;
    const status = await fetch(`${amiro.baseUrl}/api/auth/status`).then((r) => r.json() as Promise<{ needsSetup: boolean }>);
    if (!status.needsSetup) {
      test.info().annotations.push({ type: "info", description: "instance already set up; signing in instead" });
      await ensureSignedIn(page);
      await saveAuth(page);
      test.skip(true, "instance is already onboarded (external target)");
    }

    await step("Open Amiro for the first time → redirected to the welcome screen", async () => {
      await page.goto("/");
      await expect(page).toHaveURL(/\/onboarding/);
      await expect(page.getByRole("heading", { level: 1 })).toContainText(/set\s+up/i);
      await expect(page.getByRole("button", { name: "Get started" })).toBeVisible();
    });

    await step("Get started → account step", async () => {
      await page.getByRole("button", { name: "Get started" }).click();
      await expect(page.getByText(/1 of 4/)).toBeVisible();
    });

    const create = page.getByRole("button", { name: "Create account" });
    await step("Validation: weak password keeps 'Create account' disabled", async () => {
      await page.getByLabel("What should your agent call you?").pressSequentially(owner.name, { delay: 20 });
      await page.getByLabel("Email or username").pressSequentially(owner.email, { delay: 15 });
      await page.getByLabel("Password", { exact: true }).fill("short");
      await page.getByLabel("Confirm password").fill("short");
      await expect(create).toBeDisabled();
    });

    await step("Validation: mismatched confirmation keeps it disabled", async () => {
      await page.getByLabel("Password", { exact: true }).fill(owner.password);
      await page.getByLabel("Confirm password").fill(`${owner.password}x`);
      await expect(create).toBeDisabled();
    });

    await step("Show/hide password toggle works", async () => {
      const pw = page.getByLabel("Password", { exact: true });
      await expect(pw).toHaveAttribute("type", "password");
      await page.getByRole("button", { name: "Show password" }).click();
      await expect(pw).toHaveAttribute("type", "text");
      await page.getByRole("button", { name: /hide password/i }).click();
    });

    await step("Valid password + confirmation → Create account", async () => {
      await page.getByLabel("Confirm password").fill(owner.password);
      await expect(create).toBeEnabled();
      await create.click();
      await expect(page.getByText(/2 of 4/)).toBeVisible({ timeout: 30000 });
    });

    await step(`Agent step: name it "${agent.name}", pick ${agent.look} look and ${agent.colour} colour`, async () => {
      await expect(page.getByRole("heading", { name: /meet your agent/i })).toBeVisible();
      await page.getByLabel("Name", { exact: true }).fill(agent.name);
      await page.getByRole("radio", { name: new RegExp(agent.look) }).click();
      await page.getByRole("radio", { name: agent.colour, exact: true }).click();
      await expect(page.getByRole("radio", { name: agent.colour, exact: true })).toBeChecked();
      await page.getByRole("button", { name: "Continue" }).click();
    });

    await step("Brain step: the copy uses the new agent name", async () => {
      await expect(page.getByText(/3 of 4/)).toBeVisible();
      await expect(page.getByText(new RegExp(`${agent.name} thinks with a model`))).toBeVisible();
    });

    await step("Brain step: 'more providers' panel lists the configured provider", async () => {
      await page.getByRole("button", { name: /Subscriptions, local models and more providers/ }).click();
      await page.getByRole("textbox", { name: "Search providers" }).fill(amiro.cfg.provider.label);
      await expect(page.getByRole("combobox").first()).toBeVisible();
      await expect(page.getByText(/providers · \d+ connected/)).toBeVisible();
    });

    await step("Skip the brain for now (it is configured via Admin in journey 2)", async () => {
      await page.getByRole("button", { name: "Skip for now" }).click();
      await expect(page.getByRole("heading", { name: new RegExp(`Say hi to ${agent.name}`) })).toBeVisible();
      await expect(page.getByText(/AI provider: skipped/)).toBeVisible();
      await expect(page.getByText(`Signed in as ${owner.email}`)).toBeVisible();
    });

    await step("Start chatting → the Team view with the agent's channel open, the agent in the sidebar and a setup reminder", async () => {
      await page.getByRole("button", { name: "Start chatting" }).click();
      await expect(page).toHaveURL(/\/team/);
      await expect(page.getByTestId("team-channel-title")).toHaveText(agent.name);
      await expect(page.getByRole("link", { name: new RegExp(`${agent.name}.*Personality`) })).toBeVisible();
      await expect(page.getByRole("link", { name: "Connect an AI provider" })).toBeVisible();
      const h1 = (await page.locator("main h1").first().innerText().catch(() => "")).trim();
      if (!h1) note("Home page renders an empty <h1> (no greeting) when no provider is connected.");
    });

    await step("Reload keeps the session (no bounce back to onboarding)", async () => {
      await page.reload();
      await expect(page).not.toHaveURL(/onboarding|sign-in/);
      await saveAuth(page);
    });
  });

  test("sign out, wrong password is rejected, sign back in", async ({ page, step, amiro }) => {
    const { owner } = amiro.cfg;
    await step("Open the user menu → Sign out", async () => {
      await page.goto("/");
      await page.getByRole("button", { name: new RegExp(owner.email) }).click();
      await page.getByRole("menuitem", { name: /sign out|log out/i }).click();
      await expect(page).toHaveURL(/sign-in/, { timeout: 20000 });
    });

    await step("Wrong password shows an error and stays on sign-in", async () => {
      await page.getByLabel(/email|username/i).first().fill(owner.email);
      await page.getByLabel(/password/i).first().fill("definitely-wrong-123");
      await page.getByRole("button", { name: /sign in|log in|continue/i }).first().click();
      await expect(page.getByText(/invalid|incorrect|wrong|failed/i).first()).toBeVisible();
      await expect(page).toHaveURL(/sign-in/);
    });

    await step("Correct password signs back in", async () => {
      await page.getByLabel(/password/i).first().fill(owner.password);
      await page.getByRole("button", { name: /sign in|log in|continue/i }).first().click();
      await expect(page).not.toHaveURL(/sign-in/, { timeout: 30000 });
      await saveAuth(page);
    });
  });
});
