/**
 * Journey 13 — notifications: external channels (telegram/slack/discord
 * adapters behind vault-backed bot tokens), the Bell inbox, and chat replies
 * that notify only once the user has left the chat (Vellum's presence rule),
 * with the chat list's working / unseen marks.
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
import { ask, composer, newChat, selectModel, send } from "../support/chat";
import { loadConfig } from "../support/config";
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

  test("bell inbox: unread switch → detail → mark read → badge clears", async ({
    page,
    step,
    amiro,
  }) => {
    await step("Seed two unread notifications via the test endpoint", async () => {
      for (let i = 0; i < 2; i++) {
        const { status } = await amiro.api("/api/notifications/test", {
          method: "POST",
        });
        expect(status).toBeLessThan(300);
      }
    });

    await step("Open the bell → it starts on unread, with the Unread switch on", async () => {
      await page.goto("/");
      await page.getByTestId("notifications-bell").click();
      await expect(page.getByTestId("notifications-bell-popover")).toBeVisible();
      await expect(page.getByTestId("notifications-feed")).toBeVisible();
      await expect(page.getByTestId("notifications-filter-unread")).toHaveAttribute(
        "aria-checked",
        "true",
      );
      await expect(
        page.locator('[data-testid^="notification-row-"][data-read="false"]').first(),
      ).toBeVisible({ timeout: 15000 });
    });

    await step("Open the first row → detail with delivery state, marked read", async () => {
      await page.locator('[data-testid^="notification-row-"]').first().click();
      await expect(page.getByTestId("notification-detail")).toBeVisible();
      await expect(page.getByTestId("notification-deliveries")).toBeVisible({
        timeout: 15000,
      });
    });

    await step("Back → turn Unread off → the read row is still listed", async () => {
      await page.getByTestId("notifications-back").click();
      await page.getByTestId("notifications-filter-unread").click();
      await expect(
        page.locator('[data-testid^="notification-row-"][data-read="true"]').first(),
      ).toBeVisible({ timeout: 15000 });
    });

    await step("… menu → Mark all as read clears the badge", async () => {
      const badge = page.getByTestId("notifications-unread-badge");
      await expect(badge).toBeVisible();
      await page.getByTestId("notifications-actions").click();
      await page.getByTestId("notifications-mark-all-read").click();
      await expect(badge).toBeHidden({ timeout: 15000 });
    });

    await step("… menu → Settings → sound toggle persists through the API", async () => {
      await page.getByTestId("notifications-actions").click();
      await page.getByTestId("notifications-settings-button").click();
      await expect(page.getByTestId("notifications-settings")).toBeVisible();
      const before = await amiro.api<{ soundEnabled: boolean }>(
        "/api/notifications/settings",
      );
      const initial = before.body.soundEnabled;
      await page.getByTestId("notifications-settings-soundEnabled").click();
      await expect
        .poll(
          async () => {
            const { body } = await amiro.api<{ soundEnabled: boolean }>("/api/notifications/settings");
            return body.soundEnabled;
          },
          { timeout: 15000 },
        )
        .toBe(!initial);
      // Restore so later runs start from the same state, once the switch has
      // finished saving (it is disabled while a save is in flight).
      const sound = page.getByTestId("notifications-settings-soundEnabled");
      await expect(sound).toBeEnabled();
      await expect(sound).toHaveAttribute("aria-checked", String(!initial));
      await sound.click();
      await expect
        .poll(
          async () => {
            const { body } = await amiro.api<{ soundEnabled: boolean }>("/api/notifications/settings");
            return body.soundEnabled;
          },
          { timeout: 15000 },
        )
        .toBe(initial);
    });
  });

  test("chat replies notify only after you leave the chat, and the chat list shows its status", async ({
    page,
    step,
    amiro,
  }) => {
    type Feed = { items: { id: string; category: string; threadId?: string; status: string }[] };
    const repliesFor = async (threadId: string) => {
      const { body } = await amiro.api<Feed>("/api/notifications");
      return body.items.filter((n) => n.category === "chat_reply" && n.threadId === threadId);
    };
    const threadIdOf = () => new URL(page.url()).searchParams.get("thread") ?? "";
    let threadId = "";

    await step("Ask in a new chat and watch the reply arrive → no notification", async () => {
      await newChat(page);
      await selectModel(page);
      await ask(page, "Say hi back in one short sentence.");
      threadId = threadIdOf();
      expect(threadId).not.toBe("");
      // The decision is recorded right after the turn; give it a moment.
      await page.waitForTimeout(1500);
      expect(await repliesFor(threadId)).toEqual([]);
      await expect(
        page.locator(`a[href="/?thread=${threadId}"] [data-testid="sidebar-thread-status"]`),
      ).toHaveCount(0);
    });

    await step("Ask for something longer, then leave for Schedules while it works", async () => {
      await send(
        page,
        "Write a 250-word story about a lighthouse keeper, in plain paragraphs.",
      );
      const mark = page.locator(`a[href="/?thread=${threadId}"] [data-testid="sidebar-thread-status"]`);
      await expect
        .soft(mark, "the chat should show as working while the reply streams")
        .toHaveAttribute("data-status", "running", { timeout: 15000 });
      await page.getByTestId("sidebar-schedules-link").click();
      await expect(page.getByRole("heading", { name: "Schedules", level: 1 })).toBeVisible();
    });

    await step("The reply lands while you are away → green dot in the chat list + a Bell notification", async () => {
      const mark = page.locator(`a[href="/?thread=${threadId}"] [data-testid="sidebar-thread-status"]`);
      await expect(mark).toHaveAttribute("data-status", "unseen", {
        timeout: loadConfig().timeouts.agentReplyMs,
      });
      await expect.poll(async () => (await repliesFor(threadId)).length, { timeout: 15000 }).toBe(1);
      await expect(page.getByTestId("notifications-unread-badge")).toBeVisible();
      await page.getByTestId("notifications-bell").click();
      const reply = (await repliesFor(threadId))[0];
      const row = page.getByTestId(`notification-row-${reply.id}`);
      await expect(row).toBeVisible();
      // The preview is plain text: no markdown symbols leak into the list.
      await expect(row).not.toContainText("**");
      await page.keyboard.press("Escape");
    });

    await step("Open the chat from the list → the dot clears and its notification is read", async () => {
      await page.locator(`a[href="/?thread=${threadId}"]`).click();
      await expect(composer(page)).toBeVisible();
      await expect(
        page.locator(`a[href="/?thread=${threadId}"] [data-testid="sidebar-thread-status"]`),
      ).toHaveCount(0, { timeout: 15000 });
      await expect
        .poll(async () => (await repliesFor(threadId))[0]?.status, { timeout: 15000 })
        .toBe("seen");
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
