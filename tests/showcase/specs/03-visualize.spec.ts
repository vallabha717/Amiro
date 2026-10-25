/**
 * Scene: charts inline in the answer (the Visualize superpower) from data
 * the agent looks up on the web.
 */
import { askAndShow, freshChat, hold, scene, test } from "../support";

test("visualize: look up real numbers and chart them inline", async ({ page, step }) => {
  scene("visualize");

  await step("Ask for numbers from the web, drawn as a chart", async () => {
    await freshChat(page);
    await askAndShow(
      page,
      "Search the web for India's total installed solar power capacity (GW) at the end of each year from 2019 to 2024, then use the visualize skill to draw it as an inline bar chart with a one-line takeaway. Mention your source.",
      420000,
    );
  });

  await step("The chart renders right in the reply — no export, no extra app", async () => {
    const visual = page.locator("main iframe, main article svg, main article canvas").first();
    await visual.scrollIntoViewIfNeeded().catch(() => {});
    await hold(page, 5000);
  });
});

