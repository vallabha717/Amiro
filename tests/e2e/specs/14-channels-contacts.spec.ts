/**
 * Journey 14 — Channels, Contacts, and notifications outside Amiro, wired the
 * Vellum way: the bot lives in Channels, your own account lives on your
 * contact card in Contacts (verified with a code sent through the channel),
 * and notifications go to that account with that bot.
 *
 * Runs against the offline Telegram / Slack / Discord stub that global setup
 * starts (`AMIRO_E2E_NOTIFY_STUB`), so it proves real token checks, real
 * verification codes and real deliveries without any real token:
 *
 *   - Channels: a rejected bot token is refused and nothing is saved; a good
 *     one connects and shows the bot's name as the provider reports it.
 *   - Contacts: add your Telegram account to "You", get a code in Telegram,
 *     type it back, and the account is verified.
 *   - Notifications: Admin → Notifications shows Telegram ready (and what
 *     the others still need); a test notification lands in your Telegram.
 */
import { expect, test } from "../support/fixtures";

const GOOD_TOKEN = "e2e-telegram-bot-token";
const BAD_TOKEN = "e2e-bad-token";
const MY_TELEGRAM_ID = "777000";

type StubCall = { api: string; chat_id?: string | number; text?: string };

async function stubCalls(): Promise<StubCall[]> {
  const base = process.env.AMIRO_E2E_NOTIFY_STUB;
  if (!base) throw new Error("the notify stub is not running (global setup starts it)");
  const res = await fetch(`${base}/__calls`);
  return ((await res.json()) as { calls: StubCall[] }).calls;
}

async function telegramMessagesTo(chatId: string): Promise<string[]> {
  return (await stubCalls())
    .filter((c) => c.api === "telegram.sendMessage" && String(c.chat_id) === chatId)
    .map((c) => c.text ?? "");
}

test.describe("channels and contacts", () => {
  test("channels: a bot token is checked with Telegram before it is saved", async ({ page, step, amiro }) => {
    await step("Open Channels → Telegram → connect manually", async () => {
      await page.goto("/channels");
      await expect(page.getByTestId("channels-page")).toBeVisible();
      await page.getByTestId("channel-row-telegram").click();
      await page.getByTestId("telegram-connect-manual-button").click();
      await expect(page.getByTestId("telegram-bot-token-input")).toBeVisible();
    });

    await step("A rejected token → a clear error, nothing saved", async () => {
      await page.getByTestId("telegram-bot-token-input").fill(BAD_TOKEN);
      await page.getByTestId("telegram-save-button").click();
      await expect(page.getByText(/Telegram rejected that bot token/)).toBeVisible();
      const { body } = await amiro.api<{ hasBotToken: boolean }>("/api/integrations/telegram/config");
      expect(body.hasBotToken).toBe(false);
    });

    await step("A good token → connected, showing the bot's real name", async () => {
      await page.getByTestId("telegram-bot-token-input").fill(GOOD_TOKEN);
      await page.getByTestId("telegram-save-button").click();
      await expect(page.getByText("@e2e-bot")).toBeVisible({ timeout: 15000 });
      const { body } = await amiro.api<{ hasBotToken: boolean; botUsername: string }>(
        "/api/integrations/telegram/config",
      );
      expect(body.hasBotToken).toBe(true);
      expect(body.botUsername).toBe("e2e-bot");
      expect(JSON.stringify(body)).not.toContain(GOOD_TOKEN);
      expect(await page.locator("body").innerText()).not.toContain(GOOD_TOKEN);
    });
  });

  test("contacts: add your Telegram account and verify it with the code it receives", async ({ page, step, amiro }) => {
    let guardianId = "";

    await step("Open Contacts → your own card (You)", async () => {
      const { body } = await amiro.api<{ contacts: { id: string; role: string }[] }>("/api/contacts");
      guardianId = body.contacts.find((c) => c.role === "guardian")!.id;
      await page.goto("/contacts");
      await expect(page.getByTestId("contacts-page")).toBeVisible();
      await page.getByTestId(`contact-row-${guardianId}`).click();
      await expect(page.getByTestId("contact-detail-card")).toBeVisible();
    });

    await step("Add your Telegram user id → listed as not yet verified", async () => {
      await page.getByTestId("add-channel-type-select").selectOption("telegram");
      await page.getByTestId("add-channel-address-input").fill(MY_TELEGRAM_ID);
      await page.getByTestId("add-channel-button").click();
      await expect(page.getByTestId("verify-channel-telegram")).toBeVisible();
    });

    let code = "";
    await step("Verify me → Amiro sends a code to your Telegram", async () => {
      const before = (await telegramMessagesTo(MY_TELEGRAM_ID)).length;
      await page.getByTestId("verify-channel-telegram").click();
      await expect(page.getByTestId("verify-code-form")).toBeVisible();
      await expect.poll(async () => (await telegramMessagesTo(MY_TELEGRAM_ID)).length).toBe(before + 1);
      const message = (await telegramMessagesTo(MY_TELEGRAM_ID)).at(-1)!;
      code = message.match(/\b(\d{6})\b/)?.[1] ?? "";
      expect(code, `no code in ${message}`).toMatch(/^\d{6}$/);
    });

    await step("A wrong code is refused; the right one verifies the account", async () => {
      await page.getByTestId("verify-code-input").fill(code === "000000" ? "111111" : "000000");
      await page.getByTestId("verify-code-submit").click();
      await expect(page.getByText(/That code is not right/)).toBeVisible();
      await page.getByTestId("verify-code-input").fill(code);
      await page.getByTestId("verify-code-submit").click();
      await expect(page.getByTestId("verify-code-form")).toBeHidden({ timeout: 15000 });
      await expect(page.getByTestId("verify-channel-telegram")).toHaveCount(0);
      const { body } = await amiro.api<{ contact?: { channels: { type: string; status: string; verifiedVia?: string }[] } }>(
        `/api/contacts/${guardianId}`,
      );
      const telegram = body.contact?.channels.find((c) => c.type === "telegram");
      expect(telegram?.status).toBe("active");
      expect(telegram?.verifiedVia).toBe("code");
    });
  });

  test("notifications: your test notification arrives on your verified Telegram", async ({ page, step }) => {
    await step("Admin → Notifications shows Telegram ready, and what Slack and Discord still need", async () => {
      await page.goto("/admin/notifications");
      const telegram = page.getByTestId("channel-delivery-telegram");
      await page.getByTestId("channel-delivery-section").scrollIntoViewIfNeeded();
      await expect(telegram).toHaveAttribute("data-ready", "true", { timeout: 15000 });
      await expect(telegram).toContainText(MY_TELEGRAM_ID);
      await expect(telegram).toContainText("e2e-bot");
      await expect(page.getByTestId("channel-delivery-slack")).toHaveAttribute("data-step", "connect_bot");
      await expect(page.getByTestId("channel-delivery-fix-slack")).toHaveAttribute("href", "/channels");
      // Nothing to type here: no token or chat-id fields on this page.
      await expect(page.getByTestId("secret-prompt-card")).toHaveCount(0);
    });

    await step("Bell → … → Send a test notification → it lands in Telegram", async () => {
      const before = (await telegramMessagesTo(MY_TELEGRAM_ID)).length;
      await page.getByTestId("notifications-bell").click();
      await page.getByTestId("notifications-actions").click();
      await page.getByTestId("notifications-send-test").click();
      await expect.poll(async () => (await telegramMessagesTo(MY_TELEGRAM_ID)).length, { timeout: 15000 }).toBe(
        before + 1,
      );
      expect((await telegramMessagesTo(MY_TELEGRAM_ID)).at(-1)).toContain("Amiro Test Notification");
    });

    await step("The notification's detail shows it was sent to Telegram", async () => {
      await page.locator('[data-testid^="notification-row-"]').first().click();
      await expect(page.getByTestId("notification-delivery-telegram")).toContainText(/Sent/i, {
        timeout: 15000,
      });
    });
  });
});
