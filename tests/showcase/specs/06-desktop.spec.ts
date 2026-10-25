/**
 * Scene: the agent's own desktop (needs the sandbox: Docker + the
 * amiro-agent:local image). Watch Amiro browse a real site on its desktop
 * from the TV in the chat header, then open a second site in a new tab.
 */
import { readInstance } from "../../e2e/support/config";
import { askAndShow, expect, freshChat, hold, scene, test } from "../support";

test("desktop: watch the agent work on its own computer", async ({ page, step }) => {
  scene("agent-desktop");
  test.skip(!readInstance().sandbox, "needs the sandbox (bash scripts/sandbox.sh up)");

  await step("The Monitor button in the chat header opens the TV: Amiro's live desktop", async () => {
    await freshChat(page);
    await page.getByTestId("assistant-desktop-affordance").click();
    await expect(page.getByTestId("assistant-desktop-preview")).toBeVisible();
    await expect(page.getByTestId("desktop-panel-status")).toHaveCount(0, { timeout: 60000 });
    await hold(page, 3000);
    await page.getByTestId("desktop-preview-close").click();
  });

  await step("Ask Amiro to open a real site in the browser on its desktop", async () => {
    await askAndShow(
      page,
      "Use desktop_open to open https://news.ycombinator.com in the browser on your desktop. Then fetch that page and tell me the top 3 stories with one line each.",
    );
  });

  await step("The chat shows a live TV card with the exact page that is open", async () => {
    const card = page.getByTestId("desktop-chat-card").last();
    await expect(card).toBeVisible({ timeout: 30000 });
    await card.scrollIntoViewIfNeeded();
    await hold(page, 3500);
  });

  await step("Full screen: the header names the window in front", async () => {
    await page.getByTestId("desktop-chat-card").last().getByTestId("desktop-chat-card-fullscreen").click();
    const modal = page.getByTestId("assistant-desktop-modal");
    await expect(modal.getByTestId("desktop-panel-viewport").locator("canvas")).toBeVisible({ timeout: 45000 });
    await hold(page, 4000);
    await page.getByTestId("desktop-modal-close").click();
  });

  // Files and the terminal are left out on purpose: they draw the recording
  // machine's real home path inside the desktop picture, which the page-text
  // mask cannot reach.
  await step("Another site, another tab: Amiro keeps working in the same browser", async () => {
    await askAndShow(
      page,
      "Now open https://github.com/vallabha717/Amiro in a new tab on your desktop and tell me in two lines what the project is.",
    );
    const card = page.getByTestId("desktop-chat-card").last();
    await card.scrollIntoViewIfNeeded().catch(() => {});
    await hold(page, 4000);
  });
});
