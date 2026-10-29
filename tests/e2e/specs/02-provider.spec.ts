/**
 * Journey 2 — connect the AI provider through Admin → Models & Providers,
 * test the configured model, and make it the chat model. Every later journey
 * depends on this one.
 */
import { ask, assistantMessages, newChat, selectModel } from "../support/chat";
import { expect, need, test } from "../support/fixtures";

test.describe("provider", () => {
  test("connect the provider in Admin, test the model, chat with it", async ({ page, step, note, amiro }) => {
    const { provider } = amiro.cfg;
    need(provider.apiKey, "provider.apiKey");
    let model = provider.model;

    await step("Sidebar → Admin opens Models & Providers (empty state)", async () => {
      await page.goto("/");
      await page.getByRole("link", { name: "Admin" }).click();
      await expect(page).toHaveURL(/\/admin\/providers/);
      await expect(page.getByRole("heading", { name: "My Providers" })).toBeVisible();
    });

    await step(`Add Provider → search "${provider.label}" → select it`, async () => {
      await page.getByRole("button", { name: "Add Provider" }).click();
      const picker = page.getByRole("dialog").getByRole("combobox");
      await expect(picker).toBeFocused();
      await picker.pressSequentially(provider.label, { delay: 30 });
      await page.getByRole("option", { name: new RegExp(`^${provider.label}\\b`) }).click();
      await expect(page.getByRole("combobox").first()).toContainText(provider.label);
      await expect(page.getByText(`Stored server-side in ${provider.id}.env`)).toBeVisible();
    });

    await step("Save key stays disabled until a key is pasted; the key is masked", async () => {
      const save = page.getByRole("button", { name: "Save key" });
      await expect(save).toBeDisabled();
      const field = page.getByLabel("API key", { exact: true });
      await field.fill(provider.apiKey);
      await expect(field).toHaveAttribute("type", "password");
      await expect(save).toBeEnabled();
    });

    await step("Save key → provider connected, models listed", async () => {
      await page.getByRole("button", { name: "Save key" }).click();
      await expect(page.getByText(/Saved\..*available in the model picker/)).toBeVisible({ timeout: 60000 });
      const card = page.locator(`[data-testid="provider-card"][data-provider-id="${provider.id}"]`);
      await expect(card).toBeVisible();
      // Use the configured model, or the fallback when the provider does not offer it.
      if (!(await card.getByText(provider.model, { exact: true }).isVisible().catch(() => false))) {
        note(`${provider.model} is not offered by ${provider.id}; using fallback ${provider.fallbackModel}.`, "info");
        model = provider.fallbackModel;
      }
      await expect(card.getByText(model, { exact: true })).toBeVisible();
    });

    await step("The raw key is never shown back in the page", async () => {
      expect(await page.locator("body").innerText()).not.toContain(provider.apiKey);
    });

    await step("Models & test → pick the model → Run model test", async () => {
      await page.getByRole("button", { name: "Models & test" }).click();
      await expect(page).toHaveURL(/\/admin\/providers\/test/);
      await page.getByRole("textbox", { name: "Search available models" }).fill(model);
      await page.getByRole("button", { name: model, exact: true }).click();
      await expect(page.getByRole("button", { name: new RegExp(`${model}.*Selected`) })).toBeVisible();
      const started = Date.now();
      await page.getByRole("button", { name: "Run model test" }).click();
      // Either a result or an error appears; an error is a product bug, recorded softly so the journey continues.
      const failure = page.getByText(/Action could not be completed|Request failed|could not be completed/i).first();
      const outcome = await Promise.race([
        page.getByText(/^(Model responded|Test failed|Model reply)/).first().waitFor({ timeout: 120000 }).then(() => "result"),
        failure.waitFor({ timeout: 120000 }).then(() => "error"),
      ]).catch(() => "timeout");
      const secs = (Date.now() - started) / 1000;
      if (outcome === "error") note(`Model test error: "${(await failure.locator("..").innerText()).replace(/\s+/g, " ")}"`);
      if (secs > 20) note(`Model test took ${secs.toFixed(0)}s.`);
      // Prerequisite journey: record product bugs, don't fail (that would skip every later journey).
      if (outcome !== "result") note(`"Run model test" did not show a result (${outcome}).`, "bug");
    });

    await step("Sidebar setup checklist no longer asks to connect a provider", async () => {
      const stale = await page.getByRole("link", { name: "Connect an AI provider" }).isVisible();
      if (stale) note("Sidebar 'Finish setting up → Connect an AI provider' is still shown after a provider is connected.", "bug");
    });

    await step("Back on the providers list, set the configured model as the default directly on the provider card", async () => {
      await page.getByText("Back to providers").click();
      const card = page.locator(`[data-testid="provider-card"][data-provider-id="${provider.id}"]`);
      await expect(card).toBeVisible();
      const setBtn = card.locator(`[data-testid="provider-set-default-model"][data-model="${model}"]`);
      if (await setBtn.isVisible().catch(() => false)) {
        await setBtn.click();
      }
      const badge = card.getByTestId("provider-default-model-badge").first();
      await expect(badge).toContainText(`Default model: ${model}`);
    });

    await step("New chat → pick the model in the composer", async () => {
      await newChat(page);
      const shown = (await page.getByTestId("selected-model-name").first().innerText()).trim();
      if (shown !== model) note(`Composer started on "${shown}" — not the admin default or the configured model.`);
      expect(await selectModel(page)).toBe(model);
    });

    await step("Send a first message and get a real reply from the model", async () => {
      const reply = await ask(page, "Reply with exactly the word PONG and nothing else.");
      expect(reply.toUpperCase()).toContain("PONG");
    });

    await step("The model choice sticks for the next new chat", async () => {
      await newChat(page);
      await expect(page.getByTestId("selected-model-name").first()).toHaveText(model);
    });
  });

  test("web search through your own 9Router: connect it in Admin → Search, make it the default, the agent searches with it", async ({
    page,
    step,
    amiro,
  }) => {
    const { nineRouterApiBase, nineRouterApiKey } = amiro.cfg.search;
    need(nineRouterApiKey && nineRouterApiBase, "search.nineRouterApiBase + search.nineRouterApiKey");

    await step("Admin → Search → Add: 9Router asks for its key (hidden) and its API base URL", async () => {
      await page.goto("/admin/search");
      await page.getByTestId("add-search-provider-button").click();
      await page.getByRole("menuitem").filter({ hasText: "9Router" }).click();
      await expect(page).toHaveURL(/template=9router/);
      await expect(page.getByTestId("search-provider-type-trigger")).toContainText("9Router");
      await expect(page.getByTestId("search-provider-key-input")).toHaveAttribute("type", "password");
      await page.getByTestId("search-provider-name-input").fill("My 9Router");
      await page.getByTestId("search-provider-key-input").fill(nineRouterApiKey);
      await page.getByTestId("search-provider-base-url-input").fill(nineRouterApiBase);
      await page.getByTestId("search-provider-save-button").click();
      await expect(page).toHaveURL(/\/admin\/search\/?$/, { timeout: 30000 });
    });

    await step("Make 9Router the default engine; the key is never shown back", async () => {
      const card = page.getByTestId("search-provider-card").filter({ hasText: "My 9Router" });
      await expect(card).toBeVisible();
      await card.getByTestId("search-provider-default-button").click();
      const saved = await amiro.api<Array<{ provider: string; isActive: boolean; apiKey?: string }>>("/api/search/providers");
      const nine = saved.body.find((p) => p.provider === "9router");
      expect(nine?.isActive, "9Router is the default").toBe(true);
      expect(JSON.stringify(saved.body), "the key never comes back from the API").not.toContain(nineRouterApiKey);
    });

    await step("Ask about a real company: the agent's web search goes through 9Router and cites sources", async () => {
      await newChat(page);
      await selectModel(page);
      const reply = await ask(
        page,
        "Search the web: what does the company Paramount Software Solutions do, and where is it based? Answer in two sentences with a source link.",
      );
      expect.soft(reply, "the answer names the company").toMatch(/Paramount/i);
      const sources = assistantMessages(page).last().locator('a[href^="http"]');
      expect(await sources.count(), "the reply shows web sources as links").toBeGreaterThan(0);
      await expect(page.locator("main").getByText(/All configured search providers failed/)).toHaveCount(0);
    });
  });

  test("image generation through your own 9Router: set it up in Admin, try a picture, then the agent draws one in chat", async ({
    page,
    step,
    amiro,
  }) => {
    test.setTimeout(10 * 60_000);
    const { nineRouterApiBase, nineRouterApiKey } = amiro.cfg.search;
    need(nineRouterApiKey && nineRouterApiBase, "search.nineRouterApiBase + search.nineRouterApiKey");

    await step("Admin → Image Generation: not set up yet; pick 9Router, its model is filled in, the key field is hidden", async () => {
      await page.goto("/admin/image-generation");
      await expect(page.getByTestId("image-generation-status")).toContainText(/not set up/i);
      await page.getByTestId("image-provider-9router").click();
      await expect(page.getByTestId("image-model-input")).toHaveValue("ag/gemini-3.1-flash-image");
      await expect(page.getByTestId("image-api-key-input")).toHaveAttribute("type", "password");
    });

    await step("Save the 9Router address and key; the key is never shown back", async () => {
      await page.getByTestId("image-api-base-input").fill(nineRouterApiBase);
      await page.getByTestId("image-api-key-input").fill(nineRouterApiKey);
      await page.getByTestId("image-generation-save").click();
      await expect(page.getByTestId("image-generation-status")).toContainText("9Router");
      await expect(page.getByTestId("image-api-key-input")).toHaveValue("");
      const saved = await amiro.api("/api/image-generation");
      expect(JSON.stringify(saved.body), "the key never comes back from the API").not.toContain(nineRouterApiKey);
      expect((saved.body as { config: { keySet: boolean } }).config.keySet).toBe(true);
    });

    await step("Try it: a café menu illustration is drawn and shown", async () => {
      await page.getByTestId("image-try-input").fill("A hand-drawn chalkboard menu for a small Pune café, filter coffee and poha, warm colours");
      await page.getByTestId("image-try-button").click();
      await expect(page.getByTestId("image-try-result").locator("img")).toBeVisible({ timeout: 200_000 });
    });

    await step("In chat, the agent draws a poster with image_generate; the picture shows inline and is saved to Files", async () => {
      await newChat(page);
      await selectModel(page);
      await ask(
        page,
        "Use your image_generate tool to draw a small square poster for 'Brew & Bloom café, Koregaon Park': a cup of filter coffee with jasmine flowers. Then tell me in one line that it is ready.",
        { timeoutMs: 300_000 },
      );
      const card = page.getByTestId("image-generate-card").last();
      await expect(card).toBeVisible({ timeout: 30_000 });
      await expect(card).toHaveAttribute("data-status", "success");
      await expect(card.getByTestId("image-generate-picture")).toBeVisible({ timeout: 30_000 });
      const files = await amiro.api<Array<{ kind: string; mime: string }>>("/api/artifacts");
      expect(files.body.some((f) => f.kind === "image"), "the picture is kept in Files").toBe(true);
    });
  });
});
