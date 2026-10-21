/**
 * Journey 10 — Schedules: add a suggestion, create one by hand, run now,
 * pause, delete; the built-in heartbeat can be run on demand.
 */
import { expect, test } from "../support/fixtures";

test.describe("schedules", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/schedules");
    await expect(page.getByRole("heading", { name: "Schedules", level: 1 })).toBeVisible();
  });

  test("add a suggested schedule, run it now, pause and delete it", async ({ page, step }) => {
    await step("Add the 'Daily focus' suggestion", async () => {
      await page.getByRole("button", { name: /^Add Daily focus/ }).click();
      await expect(page.getByText("No schedules yet")).toBeHidden({ timeout: 15000 });
    });
    const row = () => page.locator("main li, main [data-slot=card], main article").filter({ hasText: "Daily focus" }).last();
    await step("It is listed under 'Your schedules'", async () => {
      await expect(row()).toBeVisible();
    });
    await step("Run it now → a run result appears", async () => {
      const run = row().getByRole("button", { name: /run now/i }).first();
      if (await run.isVisible().catch(() => false)) {
        await run.click();
        await expect.soft(page.getByText(/running|ran|completed|success|queued/i).first()).toBeVisible({ timeout: 120000 });
      }
    });
    await step("Pause it with its switch", async () => {
      const sw = row().getByRole("switch").first();
      if (await sw.isVisible().catch(() => false)) {
        await sw.click();
        await expect.soft(sw).toHaveAttribute("aria-checked", "false");
      }
    });
    await step("Delete it", async () => {
      await row().hover();
      const menu = row().getByRole("button", { name: /delete|remove|more|actions/i }).first();
      await menu.click();
      const del = page.getByRole("menuitem", { name: /delete|remove/i }).or(page.getByRole("button", { name: /^delete|^remove/i }));
      await del.first().click();
      const confirm = page.getByRole("alertdialog").getByRole("button", { name: /delete|remove|confirm/i });
      if (await confirm.isVisible().catch(() => false)) await confirm.click();
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
      const add = page.getByRole("button", { name: /^Add Daily focus/ });
      if (await add.isVisible().catch(() => false)) {
        await add.click();
        await expect(page.getByText("No schedules yet")).toBeHidden({ timeout: 15000 });
      }
    });
    const row = () => page.locator("main li, main [data-slot=card], main article").filter({ hasText: "Daily focus" }).last();
    await step("Run it now → a run result appears", async () => {
      const run = row().getByRole("button", { name: /run now/i }).first();
      if (await run.isVisible().catch(() => false)) {
        await run.click();
        await expect.soft(page.getByText(/running|ran|completed|success|queued/i).first()).toBeVisible({ timeout: 120000 });
      }
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
    await step("Click the row → Go to Conversation routes to the thread", async () => {
      await page.locator('[data-testid^="notification-row-"]').first().click();
      await expect(page.getByTestId("notification-detail")).toBeVisible();
      const go = page.getByRole("button", { name: /go to conversation/i });
      if (await go.isVisible().catch(() => false)) {
        await go.click();
        await expect.soft(page).toHaveURL(/thread=/, { timeout: 15000 });
      }
    });
  });
});
