/**
 * Journey 10 — Schedules: add a suggestion, create one by hand, run now,
 * pause, delete; the built-in heartbeat can be run on demand.
 */
import type { Page } from "@playwright/test";
import { assistantMessages, waitForReply } from "../support/chat";
import { expect, test } from "../support/fixtures";

/** Adding a suggestion opens the Create schedule form pre-filled; confirm it. */
async function addDailyFocus(page: Page) {
  await page.getByRole("button", { name: /^Add Daily focus/ }).click();
  const create = page.getByRole("button", { name: "Create schedule" });
  if (await create.isVisible({ timeout: 5000 }).catch(() => false)) await create.click();
  await expect(page.getByText("No schedules yet")).toBeHidden({ timeout: 15000 });
}

test.describe("schedules", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/schedules");
    await expect(page.getByRole("heading", { name: "Schedules", level: 1 })).toBeVisible();
  });

  test("add a suggested schedule, run it now, pause and delete it", async ({ page, step }) => {
    await step("Add the 'Daily focus' suggestion → confirm it in the pre-filled form", async () => {
      await addDailyFocus(page);
    });
    const row = () => page.getByTestId("schedule-row").filter({ hasText: "Daily focus" }).last();
    await step("It is listed under 'Your schedules'", async () => {
      await expect(row()).toBeVisible();
    });
    await step("Run it now → a run result appears", async () => {
      await row().getByRole("button", { name: "More for Daily focus" }).click();
      await page.getByRole("menuitem", { name: "Run now" }).click();
      await expect.soft(page.getByText(/running|ran|completed|success|queued/i).first()).toBeVisible({ timeout: 120000 });
    });
    await step("Pause it with its switch", async () => {
      const sw = row().getByRole("switch").first();
      if (await sw.isVisible().catch(() => false)) {
        await sw.click();
        await expect.soft(sw).toHaveAttribute("aria-checked", "false");
      }
    });
    await step("Delete it", async () => {
      await row().getByRole("button", { name: "More for Daily focus" }).click();
      await page.getByRole("menuitem", { name: /delete/i }).click();
      await page.getByRole("dialog", { name: /delete schedule/i }).getByRole("button", { name: "Delete" }).click();
      await expect.soft(page.getByText("No schedules yet")).toBeVisible({ timeout: 15000 });
    });
  });

  test("create a schedule by hand", async ({ page, step }) => {
    await step("New schedule → fill name, instructions, cadence", async () => {
      await page.getByRole("button", { name: "New schedule" }).first().click();
      const d = page.getByRole("dialog");
      await expect(d).toBeVisible();
      await d.getByRole("textbox").nth(0).fill("E2E weekly digest");
      await d.getByRole("textbox").nth(1).fill("Summarise what I worked on this week in 3 bullets.");
      await d.getByRole("button", { name: /create|save|add/i }).last().click();
      await expect(d).toBeHidden();
    });
    await step("It is listed", async () => {
      await expect(page.getByText("E2E weekly digest").first()).toBeVisible();
    });
  });

  test("system heartbeat can be run on demand", async ({ page, step }) => {
    await step("Heartbeat → Run now", async () => {
      const hb = page.locator("main").getByText("Heartbeat", { exact: true }).locator("xpath=ancestor::*[3]");
      await hb.getByRole("button", { name: "Run now" }).click();
      await expect.soft(page.getByText(/ran (just now|a few seconds|\d+ seconds?)|running/i).first()).toBeVisible({ timeout: 120000 });
    });
  });

  test("schedule run raises a Bell badge and toast, click routes to thread", async ({ page, step }) => {
    await step("Add the 'Daily focus' suggestion if missing", async () => {
      if (await page.getByRole("button", { name: /^Add Daily focus/ }).isVisible().catch(() => false)) {
        await addDailyFocus(page);
      }
    });
    const row = () => page.getByTestId("schedule-row").filter({ hasText: "Daily focus" }).last();
    await step("Run it now → a run result appears", async () => {
      await row().getByRole("button", { name: "More for Daily focus" }).click();
      await page.getByRole("menuitem", { name: "Run now" }).click();
      await expect.soft(page.getByText(/running|ran|completed|success|queued/i).first()).toBeVisible({ timeout: 120000 });
    });
    await step("Bell badge shows the new delivery", async () => {
      await expect(page.getByTestId("notifications-unread-badge")).toBeVisible({ timeout: 60000 });
    });
    await step("A toast announces the delivery", async () => {
      await expect.soft(page.locator("[data-sonner-toast]").first()).toBeVisible({ timeout: 15000 });
    });
    await step("Open the Bell → the schedule result is listed", async () => {
      await page.getByTestId("notifications-bell").click();
      await expect(page.getByTestId("notifications-bell-popover")).toBeVisible();
      await expect(page.getByTestId("notifications-feed")).toBeVisible({ timeout: 15000 });
    });
    await step("Click the row → Go to Conversation routes to the thread showing the prompt and reply", async () => {
      await page.locator('[data-testid^="notification-row-"]').first().click();
      await expect(page.getByTestId("notification-detail")).toBeVisible();
      const go = page.getByRole("button", { name: /go to conversation/i });
      if (await go.isVisible().catch(() => false)) {
        await go.click();
        await expect.soft(page).toHaveURL(/thread=/, { timeout: 15000 });
        await expect
          .soft(
            page.getByText(/Write three short focus lines for today/i).first(),
          )
          .toBeVisible({ timeout: 15000 });
      }
    });
  });

  test("schedule script mode and one-time reminder cancellation work like Vellum", async ({ page, step }) => {
    await step("Create a Script schedule and run it now → stdout appears in run history", async () => {
      await page.getByRole("button", { name: "New schedule" }).first().click();
      const d = page.getByRole("dialog");
      await expect(d).toBeVisible();
      await d.getByTestId("schedule-name-input").fill("E2E script check");
      await d.getByTestId("schedule-mode-script").click();
      await d.getByTestId("schedule-prompt-input").fill("echo e2e-script-ok");
      await d.getByTestId("schedule-dialog-save").click();
      await expect(d).toBeHidden();
      const scriptRow = page.getByTestId("schedule-row").filter({ hasText: "E2E script check" }).last();
      await expect(scriptRow).toBeVisible();
      await scriptRow.click();
      await expect(page.getByTestId("schedule-detail")).toBeVisible();
      await page.getByTestId("schedule-detail-run-now").click();
      await expect.soft(page.getByText(/e2e-script-ok/i).first()).toBeVisible({ timeout: 30000 });
    });

    await step("Create a one-time reminder and cancel it from the detail panel", async () => {
      await page.getByRole("button", { name: "New schedule" }).first().click();
      const d = page.getByRole("dialog");
      await expect(d).toBeVisible();
      await d.getByTestId("schedule-name-input").fill("E2E cancellable once");
      await d.getByTestId("schedule-mode-notify").click();
      await d.getByTestId("schedule-prompt-input").fill("Future reminder to cancel");
      await d.getByTestId("schedule-cadence-once").click();
      await d.getByTestId("schedule-once-at-input").fill("2030-12-01T09:00");
      await d.getByTestId("schedule-preview-item").first().waitFor();
      await d.getByTestId("schedule-dialog-save").click();
      await expect(d).toBeHidden();
      const onceRow = page.getByTestId("schedule-row").filter({ hasText: "E2E cancellable once" }).last();
      await expect(onceRow).toBeVisible();
      await onceRow.click();
      const cancelBtn = page.getByTestId("schedule-detail-cancel-once");
      await expect(cancelBtn).toBeVisible();
      await cancelBtn.click();
      await expect.soft(page.getByText(/Cancelled/i).first()).toBeVisible({ timeout: 15000 });
    });
  });

  test("interactive inbox cleanup schedule playbook sets up keep and clean rules in chat", async ({ page, step }) => {
    await step("Schedules page displays the featured 'Inbox cleanup' playbook with default Keep and Clean Up rules", async () => {
      const card = page.getByTestId("schedule-playbook-inbox-cleanup");
      await expect(card).toBeVisible();
      await expect(page.getByTestId("playbook-clean-defaults")).toContainText(/Promotions/i);
      await expect(page.getByTestId("playbook-clean-defaults")).toContainText(/Unwanted notifications/i);
      await expect(page.getByTestId("playbook-keep-defaults")).toContainText(/Reservations this month/i);
      await expect(page.getByTestId("playbook-keep-defaults")).toContainText(/Bills from last 2 months/i);
    });

    await step("Click 'Set up this schedule for me' → routes to Chat and starts interactive setup with Amiro", async () => {
      await page.getByTestId("schedule-setup-chat-inbox-cleanup").click();
      await expect(page).toHaveURL(/\/(amiro)?(\?thread=|$)/, { timeout: 15000 });
      await waitForReply(page, { before: 0, timeoutMs: 180000 });
    });

    await step("Amiro renders the interactive Inbox Cleanup Schedule Studio with Keep and Clean Up toggles, and shows the session's animal emoji + name in the chat title and Agents panel", async () => {
      const surface = page.getByTestId("openui-surface").last();
      await expect(surface).toBeVisible({ timeout: 30000 });
      await expect(page.getByTestId("openui-switch-clean_promotions")).toBeVisible();
      await expect(page.getByTestId("openui-switch-clean_notifications")).toBeVisible();
      await expect(page.getByTestId("openui-switch-keep_reservations_month")).toBeVisible();
      await expect(page.getByTestId("openui-switch-keep_bills_2_months")).toBeVisible();

      // Verify the Agents panel shows the coordinator's animal emoji + shortName
      const coordinatorRow = page.getByTestId("session-agent-coordinator");
      await expect(coordinatorRow).toBeVisible({ timeout: 15000 });
      await expect(coordinatorRow).toContainText("Coordinator");

      const headerTitle = page.getByTestId("header-thread-title");
      const convSwitch = page.getByTestId("sidebar-switch-conversations");
      if (await convSwitch.isVisible().catch(() => false)) {
        await convSwitch.click();
      }
      const sidebarTitle = page
        .getByTestId("sidebar-thread-title")
        .filter({ hasText: "·" })
        .first();
      await expect(sidebarTitle).toBeVisible({ timeout: 15000 });
      await expect(sidebarTitle).toHaveAttribute("data-slot", "marquee-text");
      await sidebarTitle.hover();
      await page.waitForTimeout(1500);
      await expect(headerTitle).toBeVisible({ timeout: 15000 });
      await expect(headerTitle).toContainText("·");
    });

    await step("Submit the interactive Keep & Clean Up form → Amiro creates the Inbox Cleanup schedule", async () => {
      const before = await assistantMessages(page).count();
      await page.getByTestId("openui-form-submit").last().click();
      await expect(page.getByTestId("openui-form-submitted-badge").last()).toBeVisible({ timeout: 10000 });
      await waitForReply(page, { before, timeoutMs: 180000 });
    });

    await step("Return to the Schedules page → 'Inbox cleanup' is listed under Your schedules (Created in chat)", async () => {
      await page.goto("/schedules");
      const row = page.getByTestId("schedule-row").filter({ hasText: /Inbox cleanup/i }).last();
      await expect(row).toBeVisible({ timeout: 30000 });
      await expect.soft(row.getByTestId("schedule-created-in-chat")).toBeVisible();
    });
  });
});
