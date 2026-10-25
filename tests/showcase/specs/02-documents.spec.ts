/**
 * Scene: read a real page, summarise it, and keep the result as a file in
 * the agent's workspace; then open that file in Agent → Workspace.
 */
import { askAndShow, expect, freshChat, hold, readThrough, scene, test } from "../support";

test("documents: summarise an article and save notes to the workspace", async ({ page, step }) => {
  scene("documents");

  await step("Give Amiro a link and a job: summarise it and save the notes as a file", async () => {
    await freshChat(page);
    await askAndShow(
      page,
      "Read https://en.wikipedia.org/wiki/Pomodoro_Technique and summarise it in 5 bullets. Then write a Pomodoro plan for my afternoon (2pm to 6pm) and save both to notes/pomodoro.md in your workspace.",
    );
    await readThrough(page);
    await hold(page, 2000);
  });

  await step("Agent → Workspace: the file Amiro wrote is there, ready to read or edit", async () => {
    await page.goto("/agent/workspace");
    await expect(page.getByRole("heading", { name: "Workspace", level: 1 })).toBeVisible();
    const notes = page.getByRole("treeitem", { name: /^notes/ });
    if (await notes.isVisible().catch(() => false)) await notes.click();
    const file = page.getByRole("treeitem", { name: /pomodoro\.md/ });
    await file.waitFor({ timeout: 20000 }).catch(() => {});
    if (await file.isVisible().catch(() => false)) await file.click();
    await hold(page, 4000);
  });
});
