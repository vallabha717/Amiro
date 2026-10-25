/**
 * Scene: first run. Create the owner account, then the setup chat: look,
 * personality, a real provider key (OpenCode Go), Bing web search (no key;
 * DuckDuckGo answers cloud IPs with a challenge and no results).
 * Then Admin → Providers: make muse-spark the default model and test it.
 */
import { saveAuth } from "../../e2e/support/fixtures";
import { openTurn } from "../../e2e/support/setup-chat";
import { askAndShow, expect, freshChat, hold, scene, test } from "../support";

test.describe.serial("setup", () => {
  test("first run: account, look, personality, provider key and web search", async ({ page, step, amiro }) => {
    scene("setup-first-run");
    const { owner, agent, provider } = amiro.cfg;

    await step("Open Amiro for the first time → the welcome screen", async () => {
      await page.goto("/");
      await expect(page).toHaveURL(/\/onboarding/);
      await hold(page, 2000);
      await page.getByRole("button", { name: "Get started" }).click();
    });

    await step("Step 1 · Create the owner account (12+ character password; no sign-up, no cloud)", async () => {
      await page.getByLabel("What should your agent call you?").pressSequentially(owner.name, { delay: 40 });
      await page.getByLabel("Email or username").pressSequentially(owner.email, { delay: 25 });
      await page.getByLabel("Password", { exact: true }).fill(owner.password);
      await page.getByLabel("Confirm password").fill(owner.password);
      await hold(page, 1000);
      await page.getByRole("button", { name: "Create account" }).click();
      await expect(page.getByTestId("setup-chat")).toBeVisible({ timeout: 30000 });
      await openTurn(page, "greet");
      await page.getByTestId("setup-start").click();
    });

    await step(`Step 2 · Give your agent a face: ${agent.look}, ${agent.colour}`, async () => {
      await openTurn(page, "look");
      for (const look of ["Headphones", "Sprout", agent.look]) {
        await page.getByRole("radio", { name: look }).click().catch(() => {});
        await page.waitForTimeout(500);
      }
      await page.getByRole("radio", { name: new RegExp(`^${agent.colour}$`, "i") }).click();
      await hold(page, 1200);
      await page.getByTestId("setup-look-continue").click();
    });

    await step("Step 3 · Read the default prompt the agent works from (IDENTITY.md, SOUL.md)", async () => {
      const turn = await openTurn(page, "prompt");
      await hold(page, 1500);
      await turn.getByTestId("setup-prompt-tab-SOUL.md").click();
      await hold(page, 1500);
      await turn.getByTestId("setup-prompt-continue").click();
    });

    await step("Step 4 · Personality: pick a preset (fine-tune the dials later in Agent → Personality)", async () => {
      const turn = await openTurn(page, "personality");
      await turn.getByTestId("setup-preset-companion").click();
      await hold(page, 1500);
      await turn.getByTestId("setup-personality-save").click();
    });

    await step(`Step 5 · Choose a brain: search "${provider.label}" in the full provider catalog`, async () => {
      const turn = await openTurn(page, "provider");
      await turn.getByTestId("setup-provider-search").pressSequentially(provider.label, { delay: 50 });
      await hold(page, 1000);
      await turn.getByTestId(`setup-provider-${provider.id}`).click();
    });

    await step("Paste the API key → Save key. It goes to the encrypted vault, never into the chat", async () => {
      const turn = await openTurn(page, "providerConnect");
      const key = turn.getByTestId("login-api-key");
      await key.fill(provider.apiKey);
      await expect(key).toHaveAttribute("type", "password");
      await hold(page, 800);
      await turn.getByTestId("login-api-key-save").click();
      await expect(turn.getByTestId("setup-provider-continue")).toBeEnabled({ timeout: 60000 });
      await hold(page, 1200);
      await turn.getByTestId("setup-provider-continue").click();
      expect(await page.locator("body").innerText()).not.toContain(provider.apiKey);
    });

    await step("Step 6 · Web search: Bing and DuckDuckGo need no key (Brave, Tavily, Exa… take one)", async () => {
      const turn = await openTurn(page, "search");
      await hold(page, 1200);
      await turn.getByTestId("setup-search-bing").click();
    });

    await step("Steps 7-8 · Connectors and voice can wait — each skipped step stays in the sidebar", async () => {
      for (const s of ["connectors", "voice", "listen"]) {
        const turn = await openTurn(page, s);
        await page.waitForTimeout(900);
        await turn.getByTestId("setup-skip").click();
      }
    });

    await step("Summary → Start working: Amiro lands on Team with your agent as the first card", async () => {
      await openTurn(page, "done");
      await hold(page, 2500);
      await page.getByTestId("setup-finish").click();
      await expect(page).toHaveURL(/\/team$/);
      await hold(page, 1500);
      await page.getByTestId("team-open-amiro").click();
      await hold(page, 2000);
      await saveAuth(page);
    });
  });

  test("pick the default model and test it", async ({ page, step, amiro }) => {
    scene("setup-model");
    const { provider } = amiro.cfg;
    let model = provider.model;

    await step("Admin → Models & Providers: OpenCode Go is connected and lists its models", async () => {
      await page.goto("/admin/providers");
      const card = page.locator(`[data-testid="provider-card"][data-provider-id="${provider.id}"]`);
      await expect(card).toBeVisible({ timeout: 30000 });
      if (!(await card.getByText(provider.model, { exact: true }).isVisible().catch(() => false))) {
        model = provider.fallbackModel;
      }
      await card.getByText(model, { exact: true }).scrollIntoViewIfNeeded();
      await hold(page, 2000);
    });

    await step(`Set ${model} as the default model, right on the provider card`, async () => {
      const card = page.locator(`[data-testid="provider-card"][data-provider-id="${provider.id}"]`);
      const setBtn = card.locator(`[data-testid="provider-set-default-model"][data-model="${model}"]`);
      if (await setBtn.isVisible().catch(() => false)) await setBtn.click();
      await expect(card.getByTestId("provider-default-model-badge").first()).toContainText(model);
      await hold(page, 1500);
    });

    await step("Models & test → pick the model → Run model test", async () => {
      await page.getByRole("button", { name: "Models & test" }).click();
      await page.getByRole("textbox", { name: "Search available models" }).pressSequentially(model, { delay: 30 });
      await page.getByRole("button", { name: model, exact: true }).click();
      await page.getByRole("button", { name: "Run model test" }).click();
      await page
        .getByText(/^(Model responded|Test failed|Model reply)/)
        .first()
        .waitFor({ timeout: 120000 })
        .catch(() => {});
      await hold(page, 2500);
    });

    await step("New chat → the composer's model picker shows the default; say hello", async () => {
      await freshChat(page);
      await page.getByTestId("model-selector-button").first().click();
      await hold(page, 1500);
      await page.keyboard.press("Escape");
      await askAndShow(page, "Hi! In two sentences, what can you help me with day to day?");
      await hold(page, 3000);
    });
  });
});
