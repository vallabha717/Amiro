/**
 * Journey 2 — connect the AI provider through Admin → Models & Providers,
 * test the configured model, and make it the chat model. Every later journey
 * depends on this one.
 */
import { ask, newChat, selectModel } from "../support/chat";
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

    await step("Back on the providers list, check which model is the chat default", async () => {
      await page.getByText("Back to providers").click();
      const badge = page.getByTestId("provider-default-model-badge").first();
      await expect(badge).toBeVisible();
      const def = (await badge.innerText()).replace("Default model:", "").trim();
      if (def !== model) {
        note(`Admin has no way to set the default chat model: the card says "${def}" and the only control is the per-chat picker.`);
      }
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
});
