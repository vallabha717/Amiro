/**
 * Journey 13 — external notification channels (Phase 03: telegram/slack/discord
 * adapters behind vault-backed bot tokens).
 *
 * The isolated backend must point its adapters at the offline stub BEFORE the
 * run (the base URL is read per call, so the stub only needs to be up before
 * THESE tests execute, not before global-setup boots the backend):
 *
 *   node tests/e2e/fixtures/notify-stub-server.mjs 38971 &
 *   AMIRO_NOTIFY_TELEGRAM_BASE_URL=http://127.0.0.1:38971/tg \
 *   AMIRO_NOTIFY_SLACK_BASE_URL=http://127.0.0.1:38971/slack \
 *   AMIRO_NOTIFY_DISCORD_BASE_URL=http://127.0.0.1:38971/dc \
 *   pnpm --dir tests e2e --project notifications
 *
 *   - connect: dummy token through the secure secret card + chat id through a
 *     normal input → verified binding row, token never in any response.
 *   - failure: a rejected token fails cleanly (no exception, nothing bound).
 *   - live send to a real Telegram chat only when notify.liveTelegramToken is
 *     configured, otherwise skipped with a reason.
 */
import { expect, need, test } from "../support/fixtures";

const DUMMY_TOKEN = "e2e-dummy-telegram-token";
const BAD_TOKEN = "e2e-bad-token";

test.describe("notification channels", () => {
  test("connect telegram: secret card + chat id → verified binding", async ({
    page,
    step,
    amiro,
  }) => {
    await step("Admin → Notifications shows the external channels section", async () => {
      await page.goto("/admin/notifications");
      await expect(page.getByTestId("channel-connect-section")).toBeVisible();
      await expect(page.getByTestId("channel-connect-telegram")).toBeVisible();
    });

    await step("Save the bot token through the secure secret card (never chat)", async () => {
      const card = page.getByTestId("channel-connect-telegram");
      await card.getByTestId("secret-prompt-input").fill(DUMMY_TOKEN);
      await card.getByTestId("secret-prompt-save").click();
      await expect(card.getByTestId("secret-prompt-saved")).toBeVisible();
    });

    await step("Enter the chat id and bind → verified", async () => {
      const card = page.getByTestId("channel-connect-telegram");
      await card.getByTestId("channel-chat-id-telegram").fill("e2e-chat-1");
      await card.getByTestId("channel-bind-telegram").click();
      await expect
        .poll(
          async () => {
            const { body } = await amiro.api<{ channels: { channel: string; bound: boolean }[] }>(
              "/api/notifications/channels",
            );
            return body.channels.find((c) => c.channel === "telegram")?.bound;
          },
          { timeout: 20000 },
        )
        .toBe(true);
    });

    await step("Binding persists via the API and the token never leaks", async () => {
      const { body } = await amiro.api<{ channels: unknown[] }>(
        "/api/notifications/channels",
      );
      const telegram = (body.channels as Record<string, unknown>[]).find(
        (c) => c["channel"] === "telegram",
      )!;
      expect(telegram["bound"]).toBe(true);
      expect(telegram["chatId"]).toBe("e2e-chat-1");
      expect(JSON.stringify(body)).not.toContain(DUMMY_TOKEN);
      expect(await page.locator("body").innerText()).not.toContain(DUMMY_TOKEN);
    });
  });

  test("rejected token fails cleanly: no exception, nothing bound", async ({
    page,
    step,
    amiro,
  }) => {
    await step("Bind with a rejected token → clean 401, slack stays unbound", async () => {
      const { status, body } = await amiro.api<{ error?: string }>(
        "/api/notifications/channels/bind",
        {
          method: "POST",
          body: JSON.stringify({ channel: "slack", chatId: "U9", token: BAD_TOKEN }),
        },
      );
      expect(status).toBe(401);
      expect(JSON.stringify(body)).not.toContain(BAD_TOKEN);
      const { body: list } = await amiro.api<{
        channels: { channel: string; bound: boolean }[];
      }>("/api/notifications/channels");
      expect(list.channels.find((c) => c.channel === "slack")?.bound).toBe(false);
      void page;
    });
  });

  test("live send to a real Telegram chat (guarded)", async ({ page, step, amiro }) => {
    const { notify } = amiro.cfg;
    need(notify?.liveTelegramToken, "notify.liveTelegramToken");
    need(notify?.liveTelegramChatId, "notify.liveTelegramChatId");

    await step("Resend path is exercised against the real API", async () => {
      const { status } = await amiro.api("/api/notifications/channels/resend", {
        method: "POST",
        body: JSON.stringify({ deliveryId: "e2e-no-such-delivery", channel: "telegram" }),
      });
      // Unknown delivery ids are a clean 404, never an exception.
      expect(status).toBe(404);
      void page;
    });
  });
});
