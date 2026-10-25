/**
 * Scene: Team. Create a second agent (a travel planner) with its own look,
 * personality and web search through the setup chat, then give it a job.
 */
import { openTurn } from "../../e2e/support/setup-chat";
import { askAndShow, expect, hold, readThrough, scene, selectModel, test } from "../support";

test("team: add a specialist agent and give it a job", async ({ page, step, amiro }) => {
  scene("team-new-agent");

  await step("Team → New agent: the same guided setup chat, for a new teammate", async () => {
    await page.goto("/team");
    await hold(page, 1500);
    await page.getByTestId("team-new-agent").click();
    await expect(page).toHaveURL(/\/team\/new/);
    await (await openTurn(page, "greet")).getByTestId("setup-start").click();
  });

  await step("Name it Atlas, give it a role and instructions, pick a look", async () => {
    const turn = await openTurn(page, "look");
    await turn.getByTestId("setup-agent-name").pressSequentially("Atlas", { delay: 60 });
    await turn.getByTestId("setup-agent-role").pressSequentially("Travel planner", { delay: 30 });
    await turn
      .getByTestId("setup-agent-instructions")
      .pressSequentially("Plan trips with real prices, travel times and a day-by-day plan. Prefer trains over flights when it is under 8 hours.", { delay: 8 });
    await turn.getByTestId("team-shape-star").click();
    await turn.getByTestId("team-colour-cobalt").click();
    await hold(page, 1200);
    await turn.getByTestId("setup-look-continue").click();
  });

  await step("Prompt and personality are Atlas's own", async () => {
    let turn = await openTurn(page, "prompt");
    await hold(page, 1500);
    await turn.getByTestId("setup-prompt-continue").click();
    turn = await openTurn(page, "personality");
    await turn.getByTestId("setup-preset-operator").click();
    await hold(page, 1000);
    await turn.getByTestId("setup-personality-save").click();
  });

  await step(`Brain: keep ${amiro.cfg.provider.label} (copied from Amiro) · Search: Bing`, async () => {
    let turn = await openTurn(page, "provider");
    await turn.getByTestId("setup-provider-keep").click();
    turn = await openTurn(page, "search");
    await turn.getByTestId("setup-search-bing").click();
    for (const s of ["connectors", "voice", "listen"]) {
      turn = await openTurn(page, s);
      await page.waitForTimeout(700);
      await turn.getByTestId("setup-skip").click();
    }
  });

  await step("Done → Atlas's own thread opens, with its own workspace", async () => {
    const turn = await openTurn(page, "done");
    await hold(page, 2000);
    await turn.getByTestId("setup-finish").click();
    await expect(page.getByTestId("team-channel-title")).toHaveText("Atlas");
    await hold(page, 1500);
  });

  await step("Give Atlas a real job: a weekend trip, day by day", async () => {
    // muse-spark: deepseek-v4.1-flash has printed raw tool-call markup in a
    // team thread, which makes a poor demo.
    await selectModel(page, amiro.cfg.provider.model);
    await askAndShow(
      page,
      "Plan a 2-day weekend trip from Bengaluru to Mysuru next month for two people: how to get there (train or bus, roughly how long), the kind of mid-range place to stay, and a day-by-day plan with timings.",
    );
    await readThrough(page);
    await hold(page, 2500);
  });
});
