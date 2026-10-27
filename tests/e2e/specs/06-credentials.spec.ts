/**
 * Journey 6 — secrets never travel through chat.
 *   - Admin → Credentials: add / list (masked) / delete
 *   - Composer guard: pasting a key-shaped string is intercepted and offered
 *     "Store securely" instead of being sent to the model
 */
import { assistantMessages, composer, newChat } from "../support/chat";
import { expect, test } from "../support/fixtures";

const FAKE_KEY = "sk-proj-E2eFakeKey0123456789abcdefghijklmnopqrstuv";

test.describe("credentials", () => {
  test("vault: add, see it blurred, reveal on click, delete", async ({ page, step, amiro }) => {
    await step("Admin → Credentials (empty state)", async () => {
      await page.goto("/admin/credentials");
      await expect(page.getByRole("heading", { name: "Credentials", level: 1 })).toBeVisible();
    });
    await step("Add credential: service, field and secret value", async () => {
      await page.getByRole("button", { name: "Add credential" }).first().click();
      const d = page.getByRole("dialog");
      await expect(d).toBeVisible();
      const boxes = d.getByRole("textbox");
      await boxes.nth(0).fill("e2e-service");
      if ((await boxes.count()) > 2) await boxes.nth(1).fill("api_key");
      await d.locator('input[type="password"]').first().fill(FAKE_KEY);
      await d.getByRole("button", { name: /save|add|store/i }).last().click();
      await expect(d).toBeHidden();
    });
    await step("It is listed by name/env var, value never shown", async () => {
      await expect(page.getByText(/e2e-service/i).first()).toBeVisible();
      expect(await page.locator("body").innerText()).not.toContain(FAKE_KEY);
      const { body } = await amiro.api("/api/credentials");
      expect(JSON.stringify(body)).not.toContain(FAKE_KEY);
    });
    await step("Value is blurred with no copy button; clicking reveals it and offers Copy", async () => {
      const value = page.getByTestId("credential-value-e2e-service-api_key");
      await expect(value).toHaveAttribute("data-revealed", "false");
      await expect(value).not.toContainText(FAKE_KEY);
      await expect(page.getByTestId("credential-copy-value-e2e-service-api_key")).toHaveCount(0);
      await value.click();
      await expect(value).toHaveAttribute("data-revealed", "true");
      await expect(value).toContainText(FAKE_KEY);
      await expect(page.getByTestId("credential-copy-value-e2e-service-api_key")).toBeVisible();
    });
    await step("Hide it again: the secret leaves the page and Copy goes away", async () => {
      await page.getByTestId("credential-hide-e2e-service-api_key").click();
      await expect(page.getByTestId("credential-value-e2e-service-api_key")).toHaveAttribute("data-revealed", "false");
      await expect(page.getByTestId("credential-copy-value-e2e-service-api_key")).toHaveCount(0);
      expect(await page.locator("body").innerText()).not.toContain(FAKE_KEY);
    });
    await step("Delete it", async () => {
      const row = page.locator("li").filter({ hasText: /e2e-service/i }).first();
      await row.hover();
      await row.getByRole("button", { name: /delete|remove/i }).first().click();
      const confirm = page.getByRole("alertdialog").or(page.getByRole("dialog")).getByRole("button", { name: /delete|remove|confirm/i });
      if (await confirm.isVisible().catch(() => false)) await confirm.click();
      await expect(page.getByText(/e2e-service/i)).toHaveCount(0, { timeout: 15000 });
    });
  });

  test("composer guard: a pasted API key is stored securely, not sent", async ({ page, step, amiro }) => {
    await newChat(page);
    const before = await assistantMessages(page).count();

    await step("Paste a key-shaped string into the composer", async () => {
      await composer(page).click();
      await page.keyboard.type(`my openai key is ${FAKE_KEY}`, { delay: 5 });
    });
    await step("A warning appears offering 'Store securely'", async () => {
      await expect(page.getByTestId("composer-secret-notice")).toBeVisible();
      await expect(page.getByTestId("composer-store-securely")).toBeVisible();
    });
    await step("Store securely → modal with service/field prefilled", async () => {
      await page.getByTestId("composer-store-securely").click();
      const modal = page.getByTestId("store-credential-modal");
      await expect(modal).toBeVisible();
      const svc = page.getByTestId("store-credential-service");
      if (!(await svc.inputValue().catch(() => ""))) await svc.fill("openai");
      await page.getByTestId("store-credential-save").click();
      await expect(modal).toBeHidden();
    });
    await step("The key left the composer and no message was sent to the model", async () => {
      expect(await composer(page).innerText()).not.toContain(FAKE_KEY);
      expect(await assistantMessages(page).count()).toBe(before);
      expect(await page.locator("body").innerText()).not.toContain(FAKE_KEY);
    });
    await step("It shows up in Admin → Credentials", async () => {
      const { body } = await amiro.api<unknown>("/api/credentials");
      expect(JSON.stringify(body)).toMatch(/openai/i);
      expect(JSON.stringify(body)).not.toContain(FAKE_KEY);
      await page.goto("/admin/credentials");
      await expect(page.getByText(/openai/i).first()).toBeVisible();
    });
  });
});
