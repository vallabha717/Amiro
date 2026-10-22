/**
 * Journey 13 — notifications: the Bell inbox (Vellum's design) and chat
 * replies that notify only once the user has left the chat (Vellum's
 * presence rule), with the chat list's working / unseen marks.
 *
 * Delivery outside Amiro (a bot from Channels, your verified account from
 * Contacts) is journey 14, `14-channels-contacts.spec.ts`.
 */
import { ask, composer, newChat, selectModel, send } from "../support/chat";
import { loadConfig } from "../support/config";
import { expect, test } from "../support/fixtures";

test.describe("notifications", () => {
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
});
