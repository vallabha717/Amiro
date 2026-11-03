/**
 * Journey 10 — Schedules: the agenda, the built-in templates (as they are or
 * customized with the agent), create one by hand, run now, pause, delete; the
 * built-in heartbeat can be run on demand; the built-in Cleanup is set up
 * from one chat message, previewed, run and changed on the page.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Page } from "@playwright/test";
import { ask, assistantMessages, newChat, selectModel, waitForReply } from "../support/chat";
import { readInstance } from "../support/config";
import { expect, test } from "../support/fixtures";

/** A template's Review & add opens the Create schedule form pre-filled; confirm it. */
async function addTemplate(page: Page, id: string) {
  await page.getByTestId("schedules-tab-templates").click();
  await page.getByTestId(`schedule-recipe-${id}`).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByTestId("schedule-dialog-save").click();
  await expect(dialog).toBeHidden({ timeout: 15000 });
  await expect(page.getByTestId("schedules-list")).toBeVisible();
}

type ScheduleRow = { name: string; templateId?: string; enabled: boolean };
type Api = { api: <T>(path: string) => Promise<{ body: T }> };

async function listSchedules(amiro: Api): Promise<ScheduleRow[]> {
  const { body } = await amiro.api<{ schedules: ScheduleRow[] }>("/api/schedules");
  return body.schedules;
}

test.describe("schedules", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/schedules");
    await expect(page.getByRole("heading", { name: "Schedules", level: 1 })).toBeVisible();
  });

  test("schedule templates: Meera in Pune picks a ready-made afternoon reset, finds it on the agenda and pauses it", async ({ page, step, amiro }) => {
    const card = (id: string) => page.getByTestId(`schedule-playbook-${id}`);

    await step("With no schedules yet, the page opens on Templates, showing what ships with Amiro", async () => {
      if ((await listSchedules(amiro)).length > 0) await page.getByTestId("schedules-tab-templates").click();
      await expect(page.getByTestId("schedules-templates")).toBeVisible();
      const { body } = await amiro.api<{ templates: { id: string }[] }>("/api/schedules/templates");
      const templates = body.templates;
      expect(templates.length).toBeGreaterThanOrEqual(10);
      for (const t of templates) await expect(card(t.id)).toBeVisible();
    });

    await step("Filter to Wellbeing → only wellbeing templates remain", async () => {
      await page.getByTestId("schedule-category-wellbeing").click();
      await expect(card("afternoon-reset")).toBeVisible();
      await expect(card("inbox-cleanup")).toBeHidden();
    });

    await step("Open Afternoon reset → sees when and how it runs and its exact instructions", async () => {
      await page.getByTestId("schedule-template-open-afternoon-reset").click();
      const preview = page.getByTestId("schedule-template-preview");
      await expect(preview).toContainText("Weekdays at 3:00 PM");
      await expect(page.getByTestId("schedule-template-prompt")).toContainText("Time for a reset");
      await page.keyboard.press("Escape");
      await expect(preview).toBeHidden();
    });

    await step("Review & add → the form is prefilled with the template → saves it", async () => {
      await page.getByTestId("schedule-recipe-afternoon-reset").click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByTestId("schedule-name-input")).toHaveValue("Afternoon reset");
      await dialog.getByTestId("schedule-dialog-save").click();
      await expect(dialog).toBeHidden({ timeout: 15000 });
    });

    const row = () => page.getByTestId("schedule-row").filter({ hasText: "Afternoon reset" });
    await step("It lands on Your schedules, on the agenda by next run, and remembers its template", async () => {
      await expect(page.getByTestId("schedules-tab-yours")).toHaveAttribute("data-state", "active");
      await expect(row()).toBeVisible();
      await expect(page.getByTestId("schedules-next-up")).toContainText("Afternoon reset");
      const saved = (await listSchedules(amiro)).find((s) => s.name === "Afternoon reset");
      expect(saved?.templateId).toBe("afternoon-reset");
    });

    await step("The template now reads Added and links to the saved copy, even after a reload", async () => {
      await page.getByTestId("schedules-tab-templates").click();
      await page.reload();
      await expect(page.getByTestId("schedules-tab-templates")).toHaveAttribute("data-state", "active");
      await expect(page.getByTestId("schedule-template-added-afternoon-reset")).toBeVisible();
      await page.getByTestId("schedule-template-view-afternoon-reset").click();
      await expect(page.getByTestId("schedule-detail")).toContainText("Afternoon reset");
      await expect(page.getByTestId("schedule-detail-refine")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("schedule-detail")).toBeHidden();
    });

    await step("Pause it → it moves to Paused, and the status filter and search find it", async () => {
      await row().getByRole("switch").click();
      await expect(page.getByTestId("schedules-agenda-paused")).toContainText("Afternoon reset");
      expect((await listSchedules(amiro)).find((s) => s.name === "Afternoon reset")?.enabled).toBe(false);
      await page.getByTestId("schedules-filter-active").click();
      await expect(page.getByTestId("schedules-no-results")).toBeVisible();
      await page.getByTestId("schedules-clear-filters-button").click();
      await page.getByTestId("schedules-search-input").fill("afternoon");
      await expect(row()).toBeVisible();
      await page.getByTestId("schedules-search-input").fill("");
    });

    await step("Clean up: delete it", async () => {
      await row().getByRole("button", { name: "More for Afternoon reset" }).click();
      await page.getByRole("menuitem", { name: "Delete" }).click();
      await page.getByTestId("schedule-delete-confirm").click();
      await expect(row()).toBeHidden({ timeout: 15000 });
    });
  });

  test("schedule templates: Meera customizes the Week ahead template with Amiro, then changes it in chat", async ({ page, step, amiro }) => {
    await step("Templates → Customize with Amiro → a chat opens and Amiro shows the template's options as a form", async () => {
      await page.goto("/schedules?tab=templates");
      await page.getByTestId("schedule-setup-chat-week-ahead").click();
      await expect(page).toHaveURL(/\/(\?thread=|$)/, { timeout: 15000 });
      await waitForReply(page, { before: 0, timeoutMs: 180000 });
      await expect(page.getByTestId("openui-surface").last()).toBeVisible({ timeout: 30000 });
      await expect(page.getByTestId("openui-form-submit").last()).toBeVisible();
    });

    await step("Submit the choices → Amiro creates the schedule from the template", async () => {
      const before = await assistantMessages(page).count();
      await page.getByTestId("openui-form-submit").last().click();
      await waitForReply(page, { before, timeoutMs: 180000 });
      await expect
        .poll(async () => (await listSchedules(amiro)).some((s) => s.templateId === "week-ahead"), { timeout: 60000 })
        .toBe(true);
    });

    await step("Back on Schedules it's marked Created in chat, and Change with Amiro goes back to the same schedule", async () => {
      await page.goto("/schedules?tab=yours");
      const created = (await listSchedules(amiro)).find((s) => s.templateId === "week-ahead")!;
      const row = page.getByTestId("schedule-row").filter({ hasText: created.name });
      await expect(row.getByTestId("schedule-created-in-chat")).toBeVisible();
      await row.getByTestId(/schedule-row-select-/).click();
      await page.getByTestId("schedule-detail-refine").click();
      await expect(page).toHaveURL(/\/(\?thread=|$)/, { timeout: 15000 });
      await waitForReply(page, { before: 0, timeoutMs: 180000 });
      const count = (await listSchedules(amiro)).filter((s) => s.templateId === "week-ahead").length;
      expect(count, "changing a schedule must not create a second copy").toBe(1);
    });

    await step("Clean up: delete it", async () => {
      await page.goto("/schedules?tab=yours");
      const created = (await listSchedules(amiro)).find((s) => s.templateId === "week-ahead")!;
      const row = page.getByTestId("schedule-row").filter({ hasText: created.name });
      await row.getByRole("button", { name: /^More for/ }).click();
      await page.getByRole("menuitem", { name: "Delete" }).click();
      await page.getByTestId("schedule-delete-confirm").click();
      await expect(row).toBeHidden({ timeout: 15000 });
    });
  });

  test("add a template, run it now, pause and delete it", async ({ page, step }) => {
    await step("Add the 'Daily focus' template → confirm it in the pre-filled form", async () => {
      await addTemplate(page, "daily-focus");
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
      await page.getByTestId("schedule-delete-confirm").click();
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
      await page.getByTestId("schedules-tab-activity").click();
      const hb = page.getByTestId("system-task-heartbeat");
      await hb.getByRole("button", { name: "Run now" }).click();
      await expect.soft(page.getByText(/ran (just now|a few seconds|\d+ seconds?)|running/i).first()).toBeVisible({ timeout: 120000 });
    });
  });

  test("Cleanup: one message sets up a nightly cleanup of untouched chats and logs, the page previews it, cleans now and changes the age", async ({ page, step, amiro }) => {
    // Meera runs Brew & Bloom from Amiro; old supplier chats and logs pile up.
    const home = (() => {
      const state = readInstance();
      return state.sandbox?.home ?? path.join(state.root!, "home");
    })();
    const oldChatId = `e2e-old-supplier-${Date.now()}`;
    const oldLog = path.join(home, "logs", "e2e-old-cleanup.log");
    type Cleanup = { settings: { enabled: boolean; olderThanHours: number; time: string; chats: boolean; scheduleRuns: boolean; logFiles: boolean } };
    const cleanup = async () => (await amiro.api<Cleanup>("/api/housekeeping")).body.settings;
    const chatExists = async () => (await amiro.api(`/api/thread/${oldChatId}`)).status === 200;

    await step("An old supplier chat and an old log file nobody has touched for 5 days", async () => {
      const users = JSON.parse(fs.readFileSync(path.join(home, "users.json"), "utf8")) as { users: { id: string }[] };
      const threadsFile = path.join(home, "threads.json");
      const threads = JSON.parse(fs.readFileSync(threadsFile, "utf8")) as Record<string, unknown>;
      const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString();
      threads[oldChatId] = {
        title: "Sahyadri Oat Co. delivery call",
        userId: users.users[0].id,
        createdAt: fiveDaysAgo,
        lastMessageAt: fiveDaysAgo,
        archived: false,
      };
      fs.writeFileSync(threadsFile, JSON.stringify(threads, null, 2));
      fs.mkdirSync(path.dirname(oldLog), { recursive: true });
      fs.writeFileSync(oldLog, "old log line\n".repeat(200));
      const fiveDays = (Date.now() - 5 * 24 * 3600 * 1000) / 1000;
      fs.utimesSync(oldLog, fiveDays, fiveDays);
      expect(await chatExists()).toBe(true);
    });

    await step("Ask once in chat: Amiro sets up the built-in Cleanup in seconds, not a hand-made schedule", async () => {
      const schedulesBefore = (await listSchedules(amiro)).length;
      await page.goto("/");
      await newChat(page);
      await selectModel(page);
      const started = Date.now();
      await ask(page, "Every night at 2 am, delete chats, schedule run logs and log files that nobody has touched for 2 days.");
      const seconds = (Date.now() - started) / 1000;
      await expect.poll(cleanup, { timeout: 30000 }).toMatchObject({ enabled: true, olderThanHours: 48, time: "02:00", chats: true, scheduleRuns: true, logFiles: true });
      expect((await listSchedules(amiro)).length, "no agent schedule for a cleanup").toBe(schedulesBefore);
      expect.soft(seconds, "set up in well under the 5-10 minutes it used to take").toBeLessThan(90);
      expect(await chatExists(), "setting it up deletes nothing yet").toBe(true);
    });

    await step("Schedules → System tasks: Cleanup is on, nightly at 2:00 AM", async () => {
      await page.goto("/schedules");
      await page.getByTestId("schedules-tab-activity").click();
      const row = page.getByTestId("system-task-cleanup");
      await expect(row).toContainText("Daily at 2:00 AM");
      await expect(row).toContainText("untouched for 2 days");
      await expect(row.getByTestId("cleanup-toggle")).toHaveAttribute("data-state", "checked");
    });

    await step("Set up → Preview lists the old supplier chat; Clean up now deletes it and the old log", async () => {
      await page.getByTestId("cleanup-setup").click();
      const dialog = page.getByTestId("cleanup-dialog");
      await expect(dialog.getByTestId("cleanup-run-button"), "cleaning needs a preview first").toBeDisabled();
      await dialog.getByTestId("cleanup-preview-button").click();
      const preview = dialog.getByTestId("cleanup-preview");
      await expect(preview).toContainText("Sahyadri Oat Co. delivery call");
      await expect(preview).toContainText(/Would delete \d+ chats/);
      expect(await chatExists(), "a preview deletes nothing").toBe(true);
      await dialog.getByTestId("cleanup-run-button").click();
      await expect(preview).toContainText(/Deleted \d+ chats/, { timeout: 15000 });
      expect(await chatExists()).toBe(false);
      expect(fs.existsSync(oldLog)).toBe(false);
    });

    await step("Change the age to 1 week and save: the row says so", async () => {
      const dialog = page.getByTestId("cleanup-dialog");
      await dialog.getByTestId("cleanup-age").click();
      await page.getByTestId("cleanup-age-168").click();
      await dialog.getByTestId("cleanup-save").click();
      await expect(dialog).toBeHidden();
      await expect(page.getByTestId("system-task-cleanup")).toContainText("untouched for 1 week");
      expect((await cleanup()).olderThanHours).toBe(168);
    });

    await step("Turn it off from the row", async () => {
      await page.getByTestId("system-task-cleanup").getByTestId("cleanup-toggle").click();
      await expect.poll(async () => (await cleanup()).enabled).toBe(false);
    });
  });

  test("schedule run raises a Bell badge and toast, click routes to thread", async ({ page, step }) => {
    await step("Add the 'Daily focus' template if missing", async () => {
      await page.getByTestId("schedules-tab-templates").click();
      if (await page.getByTestId("schedule-recipe-daily-focus").isVisible().catch(() => false)) {
        await addTemplate(page, "daily-focus");
      } else {
        await page.getByTestId("schedules-tab-yours").click();
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
      await expect(page.getByTestId("schedule-runs-list")).toContainText("e2e-script-ok", { timeout: 30000 });
      await page.keyboard.press("Escape");
    });

    await step("A script that fails moves to Needs attention, with Ask Amiro to fix it", async () => {
      await page.getByRole("button", { name: "New schedule" }).first().click();
      const d = page.getByRole("dialog");
      await d.getByTestId("schedule-name-input").fill("E2E failing check");
      await d.getByTestId("schedule-mode-script").click();
      await d.getByTestId("schedule-prompt-input").fill("echo broken >&2; exit 3");
      await d.getByTestId("schedule-dialog-save").click();
      await expect(d).toBeHidden();
      await page.getByTestId("schedule-row").filter({ hasText: "E2E failing check" }).click();
      await page.getByTestId("schedule-detail-run-now").click();
      await expect(page.getByTestId("schedule-runs-list"), "the run updates without a reload").toContainText(/failed/i, { timeout: 30000 });
      await page.keyboard.press("Escape");
      const attention = page.getByTestId("schedules-attention");
      await expect(attention).toContainText("E2E failing check");
      await expect(attention.getByRole("button", { name: "Ask Amiro to fix it" })).toBeVisible();
      await attention.getByRole("button", { name: "More for E2E failing check" }).click();
      await page.getByRole("menuitem", { name: "Delete" }).click();
      await page.getByTestId("schedule-delete-confirm").click();
      await expect(attention).toBeHidden({ timeout: 15000 });
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
    await step("Schedules page displays the featured 'Inbox cleanup' template with default Keep and Clean Up rules", async () => {
      await page.getByTestId("schedules-tab-templates").click();
      const card = page.getByTestId("schedule-playbook-inbox-cleanup");
      await expect(card).toBeVisible();
      await expect(page.getByTestId("playbook-clean-defaults")).toContainText(/Promotions/i);
      await expect(page.getByTestId("playbook-clean-defaults")).toContainText(/Unwanted notifications/i);
      await expect(page.getByTestId("playbook-keep-defaults")).toContainText(/Reservations this month/i);
      await expect(page.getByTestId("playbook-keep-defaults")).toContainText(/Bills from last 2 months/i);
    });

    await step("Click 'Customize with Amiro' → routes to Chat and starts interactive setup with Amiro", async () => {
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
      await page.goto("/schedules?tab=yours");
      const row = page.getByTestId("schedule-row").filter({ hasText: /Inbox cleanup/i }).last();
      await expect(row).toBeVisible({ timeout: 30000 });
      await expect.soft(row.getByTestId("schedule-created-in-chat")).toBeVisible();
    });
  });
});
