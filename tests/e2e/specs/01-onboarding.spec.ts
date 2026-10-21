/**
 * Journey 1 — first run. A brand-new Amiro: welcome → account → the setup
 * chat, where Amiro streams one step at a time and each answer is a card:
 * look (the name stays Amiro), default prompt, personality, AI provider, web
 * search, connectors, voice → summary → Team. The provider is deliberately
 * left for later here; journey 2 connects it through Admin.
 */
import { DEFAULT_AGENT_NAME } from "../support/config";
import { ensureSignedIn, expect, saveAuth, test } from "../support/fixtures";
import { openTurn, replyOf } from "../support/setup-chat";

test.describe("onboarding", () => {
  test("first run: create the owner, then set Amiro up in the setup chat, step by step", async ({
    page,
    step,
    note,
    amiro,
  }) => {
    const { owner, agent, provider } = amiro.cfg;
    const status = await fetch(`${amiro.baseUrl}/api/auth/status`).then(
      (r) => r.json() as Promise<{ needsSetup: boolean }>,
    );
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
      await expect(page.getByText("Your account")).toBeVisible();
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

    await step("Create account → the setup chat opens and Amiro streams its greeting", async () => {
      await page.getByLabel("Confirm password").fill(owner.password);
      await expect(create).toBeEnabled();
      await create.click();
      await expect(page.getByTestId("setup-chat")).toBeVisible({ timeout: 30000 });
      await expect(page.getByTestId("setup-chat")).toHaveAttribute("data-mode", "onboarding");
      // The line types out first; the answer card appears once it is done.
      const greeting = page.getByTestId("setup-turn-greet").locator("[data-streaming]");
      await expect(greeting).toHaveAttribute("data-streaming", "typing");
      await expect(page.getByTestId("setup-start")).toHaveCount(0);
      await expect(greeting).toHaveAttribute("data-streaming", "done", { timeout: 20000 });
      await expect(greeting).toHaveAttribute("aria-label", /Come, let's set up your agent and start working on it/);
      await expect(page.getByTestId("setup-agent-title")).toHaveText(DEFAULT_AGENT_NAME);
    });

    await step("Let's go → Amiro asks for its look; there is no name field, the name stays Amiro", async () => {
      await page.getByTestId("setup-start").click();
      await expect(replyOf(page, "greet")).toHaveText("Let's go");
      const turn = await openTurn(page, "look");
      await expect(turn.getByTestId("setup-look-card")).toBeVisible();
      await expect(turn.getByTestId("setup-agent-name")).toHaveCount(0);
      await expect(page.getByTestId("setup-progress")).toHaveText("Step 1 of 7");
      const story = page.getByTestId("setup-story");
      await expect(story).toHaveAttribute("data-step", "look");
      await expect(page.getByTestId("setup-story-title")).toHaveText("Give your agent a face you'll love");
      await expect(page.getByTestId("setup-journey-look")).toHaveAttribute("data-state", "current");
    });

    await step(`Pick the ${agent.look} shape and ${agent.colour} colour → "That's me"`, async () => {
      await page.getByRole("radio", { name: agent.look }).click();
      await page.getByRole("radio", { name: new RegExp(`^${agent.colour}$`, "i") }).click();
      await page.getByTestId("setup-look-continue").click();
      await expect(replyOf(page, "look")).toHaveText(new RegExp(`${agent.colour}.*${agent.look}`, "i"));
      const identity = await amiro.api<{ name: string; traits: { color: string } }>("/api/agent/identity");
      expect(identity.body.name).toBe(DEFAULT_AGENT_NAME);
      expect(identity.body.traits.color).toBe(agent.colour.toLowerCase());
    });

    await step("Default prompt: IDENTITY.md and SOUL.md, exactly what the agent reads", async () => {
      const turn = await openTurn(page, "prompt");
      await expect(page.getByTestId("setup-progress")).toHaveText("Step 2 of 7");
      await expect(turn.getByTestId("setup-prompt-text")).toContainText(`**Name:** ${DEFAULT_AGENT_NAME}`);
      await turn.getByTestId("setup-prompt-tab-SOUL.md").click();
      await expect(turn.getByTestId("setup-prompt-text")).toContainText("# SOUL.md");
      await expect(turn.getByTestId("setup-prompt-text")).not.toContainText("_ Lines starting");
      await turn.getByTestId("setup-prompt-continue").click();
      await expect(replyOf(page, "prompt")).toHaveText("Looks good");
    });

    await step("Personality: pick Warm Companion → saved like the Personality page", async () => {
      const turn = await openTurn(page, "personality");
      await turn.getByTestId("setup-preset-companion").click();
      await expect(turn.getByTestId("setup-slider-companionCoworker")).toHaveValue("22");
      await turn.getByTestId("setup-personality-save").click();
      await expect(replyOf(page, "personality")).toHaveText("Warm Companion");
      const identity = await amiro.api<{ sliders: Record<string, number> }>("/api/agent/identity");
      expect(identity.body.sliders.companionCoworker).toBe(22);
    });

    await step("Provider: the side story says 'Choose a brain'; every supported provider is listed", async () => {
      const turn = await openTurn(page, "provider");
      await expect(page.getByTestId("setup-story-title")).toHaveText("Choose a brain for your agent to think with");
      await expect(page.getByTestId("setup-story-chapter")).toContainText("Chapter 4 of 7");
      await expect(page.getByTestId("setup-journey-look")).toHaveAttribute("data-state", "done");
      await expect(turn.getByRole("heading", { name: "API key", exact: true })).toBeVisible();
      const count = await turn.locator('button[data-testid^="setup-provider-"]').count();
      expect(count, "the whole catalog, not a featured few").toBeGreaterThan(10);
      await turn.getByTestId("setup-provider-search").fill(provider.label);
      await expect(turn.getByTestId(`setup-provider-${provider.id}`)).toBeVisible();
    });

    await step(`Pick ${provider.label} → Amiro guides the connect step with a secure key field`, async () => {
      await page.getByTestId(`setup-provider-${provider.id}`).click();
      await expect(replyOf(page, "provider")).toHaveText(provider.label);
      const turn = await openTurn(page, "providerConnect");
      await expect(turn.locator("[data-streaming]").first()).toHaveAttribute(
        "aria-label",
        new RegExp(`To connect ${provider.label}, paste its API key`),
      );
      await expect(turn.getByTestId("login-panel")).toBeVisible();
      await expect(turn.locator('input[type="password"]').first()).toBeVisible();
      await expect(turn.getByTestId("setup-provider-continue")).toBeDisabled();
    });

    await step("Leave the provider for later (journey 2 connects it in Admin)", async () => {
      await page.getByTestId("setup-provider-connect-card").getByTestId("setup-skip").click();
      await expect(replyOf(page, "providerConnect")).toHaveText("Skip for now");
    });

    await step("Web search: Brave asks for its key in a password field; pick another → DuckDuckGo needs none", async () => {
      let turn = await openTurn(page, "search");
      await turn.getByTestId("setup-search-brave").click();
      turn = await openTurn(page, "searchConnect");
      await expect(turn.getByTestId("setup-search-key")).toHaveAttribute("type", "password");
      await turn.getByRole("button", { name: "Pick another" }).click();
      turn = await openTurn(page, "search");
      await turn.getByTestId("setup-search-duckduckgo").click();
      await expect(replyOf(page, "search")).toHaveText("DuckDuckGo");
      const saved = await amiro.api<Array<{ provider: string; isActive: boolean }>>("/api/search/providers");
      expect(saved.body.filter((p) => p.isActive).map((p) => p.provider)).toEqual(["duckduckgo"]);
      expect(saved.body.filter((p) => p.provider === "duckduckgo"), "updated in place, not duplicated").toHaveLength(1);
    });

    await step("Connectors: Composio's key field and the MCP button; the add-server dialog opens", async () => {
      const turn = await openTurn(page, "connectors");
      await expect(page.getByTestId("setup-story-title")).toHaveText("Give your agent the superpowers it needs");
      await expect(page.getByTestId("setup-journey-provider")).toHaveAttribute("data-state", "later");
      await expect(turn.getByTestId("setup-composio-key")).toHaveAttribute("type", "password");
      await turn.getByTestId("setup-mcp-add").click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await turn.getByTestId("setup-skip").click();
      await expect(replyOf(page, "connectors")).toHaveText("Skip for now");
    });

    await step("Voice: a keyed provider asks for its key securely; pick another, then skip", async () => {
      let turn = await openTurn(page, "voice");
      await turn.getByTestId("setup-voice-openai").click();
      turn = await openTurn(page, "voiceConnect");
      await expect(turn.getByTestId("setup-voice-key")).toHaveAttribute("type", "password");
      await turn.getByRole("button", { name: "Pick another" }).click();
      turn = await openTurn(page, "voice");
      await turn.getByTestId("setup-skip").click();
    });

    await step("Summary: what was set up and what is left for later", async () => {
      const turn = await openTurn(page, "done");
      await expect(page.getByTestId("setup-story-title")).toHaveText("Your agent is ready to work");
      await expect(turn.getByTestId("setup-summary-look")).toHaveAttribute("data-state", "done");
      await expect(turn.getByTestId("setup-summary-personality")).toHaveAttribute("data-state", "done");
      await expect(turn.getByTestId("setup-summary-search")).toHaveAttribute("data-state", "done");
      await expect(turn.getByTestId("setup-summary-provider")).toHaveAttribute("data-state", "later");
      await expect(turn.getByTestId("setup-summary-voice")).toHaveAttribute("data-state", "later");
    });

    await step("Start working with Amiro → the Team page with Amiro as its first card", async () => {
      await page.getByTestId("setup-finish").click();
      await expect(page).toHaveURL(/\/team$/);
      await expect(page.getByTestId("team-agent-main")).toContainText(DEFAULT_AGENT_NAME);
    });

    await step("Open Amiro → the main app, with the agent in the sidebar and a setup reminder", async () => {
      await page.getByTestId("team-open-amiro").click();
      await expect(page.getByRole("link", { name: new RegExp(`${DEFAULT_AGENT_NAME}.*Personality`) })).toBeVisible();
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
