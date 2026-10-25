/**
 * Scene: research on the live web. A real question, answered with
 * Bing results, a comparison table and the sources it used.
 */
import { askAndShow, freshChat, hold, readThrough, scene, test } from "../support";

test("research: compare options on the live web, with sources", async ({ page, step }) => {
  scene("research");

  await step("Ask a real question that needs today's web — Amiro searches, reads and compares", async () => {
    await freshChat(page);
    await askAndShow(
      page,
      "Search the web and compare Obsidian, Logseq and Joplin for personal notes today. Give me a table with license, price, sync options and mobile apps, then one line on who each one suits. Cite the pages you used.",
    );
  });

  await step("The answer: a comparison table, a recommendation, and clickable sources", async () => {
    await readThrough(page);
    await hold(page, 2500);
  });

  await step("Follow up in the same chat — it keeps the context", async () => {
    await askAndShow(page, "I mostly write on my phone and want my notes in plain Markdown files. Which one, and why, in three bullets?");
    await hold(page, 3000);
  });
});
