/**
 * Scenes: schedules. Ask for a morning brief in plain words, find it on the
 * Schedules page and run it now; then the Inbox cleanup playbook.
 */
import { askAndShow, assistantMessages, expect, freshChat, hold, scene, test, waitForReply } from "../support";

test("schedules: a weekday morning brief, set up by asking", async ({ page, step }) => {
  scene("schedules-morning-brief");

  await step("Just ask: \"every weekday at 8, give me a morning brief\"", async () => {
    await freshChat(page);
    await askAndShow(
      page,
      "Every weekday at 8:00 am my time, give me a morning brief: the weather in Bengaluru today and the top 3 tech headlines from the web, each with a link. Set that up as an agent schedule called Morning brief.",
    );
    await hold(page, 2500);
  });

  await step("Schedules page: Morning brief is listed with its next run", async () => {
    await page.goto("/schedules");
    await expect(page.getByRole("heading", { name: "Schedules", level: 1 })).toBeVisible();
    const row = page.getByTestId("schedule-row").filter({ hasText: /Morning brief/i }).last();
    await expect(row).toBeVisible({ timeout: 30000 });
    await row.click();
    await expect(page.getByTestId("schedule-detail")).toBeVisible();
    await hold(page, 2500);
  });

  await step("Run now → Amiro does the real work: today's weather and headlines", async () => {
    await page.getByTestId("schedule-detail-run-now").click();
    // The run is done when its result lands in the Bell.
    await expect(page.getByTestId("notifications-unread-badge")).toBeVisible({ timeout: 300000 });
    await hold(page, 2000);
  });

  await step("The result arrives in the Bell inbox — open it to read the brief", async () => {
    const bell = page.getByTestId("notifications-bell");
    await bell.click();
    await expect(page.getByTestId("notifications-bell-popover")).toBeVisible();
    await hold(page, 1500);
    const rowN = page.locator('[data-testid^="notification-row-"]').first();
    if (await rowN.isVisible().catch(() => false)) {
      await rowN.click();
      const go = page.getByRole("button", { name: /go to conversation/i });
      if (await go.isVisible().catch(() => false)) await go.click();
    }
    await hold(page, 4000);
  });
});

test("schedules: the Inbox cleanup playbook", async ({ page, step }) => {
  scene("schedules-inbox-cleanup");

  await step("Schedules → the Inbox cleanup playbook: what it keeps, what it cleans up", async () => {
    await page.goto("/schedules");
    const card = page.getByTestId("schedule-playbook-inbox-cleanup");
    await expect(card).toBeVisible();
    await card.scrollIntoViewIfNeeded();
    await hold(page, 3000);
  });

  await step("Set up this schedule for me → Amiro opens a chat with the rules as switches", async () => {
    await page.getByTestId("schedule-setup-chat-inbox-cleanup").click();
    await waitForReply(page, { before: 0, timeoutMs: 300000 });
    const surface = page.getByTestId("openui-surface").last();
    await expect(surface).toBeVisible({ timeout: 30000 });
    await surface.scrollIntoViewIfNeeded();
    await hold(page, 2000);
  });

  await step("Flip the rules you want (keep bills, clean promotions…) → Submit", async () => {
    const promos = page.getByTestId("openui-switch-clean_notifications");
    if (await promos.isVisible().catch(() => false)) await promos.click();
    await hold(page, 1200);
    const before = await assistantMessages(page).count();
    await page.getByTestId("openui-form-submit").last().click();
    await waitForReply(page, { before, timeoutMs: 300000 });
    await hold(page, 2500);
  });

  await step("Back on Schedules: Inbox cleanup is saved, marked Created in chat", async () => {
    await page.goto("/schedules");
    const row = page.getByTestId("schedule-row").filter({ hasText: /Inbox cleanup/i }).last();
    await expect(row).toBeVisible({ timeout: 30000 });
    await hold(page, 3000);
  });
});
