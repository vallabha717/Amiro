/**
 * Scenes: the agent's home. Memory that carries across chats, personality
 * dials, Superpowers (skills) and the workspace files it reads every turn.
 */
import { askAndShow, expect, freshChat, hold, scene, test } from "../support";

test("memory: tell it once, it remembers in every chat", async ({ page, step }) => {
  scene("memory");

  await step("Tell Amiro about yourself once", async () => {
    await freshChat(page);
    await askAndShow(
      page,
      "Please remember for the future: I'm vegetarian, I live in Bengaluru, and I prefer working out in the morning before 8.",
    );
    await hold(page, 1500);
  });

  await step("Agent → Memory: what it keeps, as a map and as cards", async () => {
    await page.goto("/agent/memory");
    await hold(page, 3000);
    await page.getByRole("button", { name: "Cards" }).click().catch(() => {});
    await expect
      .poll(async () => /vegetarian/i.test(await page.locator("main").innerText()), { timeout: 180000, intervals: [5000] })
      .toBe(true)
      .catch(() => page.reload());
    await hold(page, 3000);
  });

  await step("A brand-new chat already knows — no need to repeat yourself", async () => {
    await freshChat(page);
    await askAndShow(page, "Suggest a quick dinner for tonight and when I should work out tomorrow.");
    await hold(page, 3500);
  });
});

test("personality, superpowers and workspace", async ({ page, step }) => {
  scene("agent-hub");

  await step("Agent hub: your agent's face, personality, superpowers, memory and workspace", async () => {
    await page.goto("/agent");
    await hold(page, 3000);
  });

  await step("Personality: start from a preset, then nudge the dials — the sample reply updates live", async () => {
    await page.locator("main").getByRole("link", { name: /Tune how I talk/ }).click();
    await page.getByRole("button", { name: "Warm Companion" }).click();
    await hold(page, 1200);
    const s = page.getByRole("slider", { name: "Playful to Serious" });
    await s.focus();
    for (let i = 0; i < 4; i += 1) {
      await page.keyboard.press("ArrowRight");
      await page.waitForTimeout(250);
    }
    await hold(page, 1500);
    await page.getByRole("button", { name: "Update personality" }).click();
    await hold(page, 1500);
  });

  await step("Superpowers: built-in skills (Visualize, Schedules, Frontend design…) and your own", async () => {
    await page.goto("/agent/superpowers");
    await hold(page, 2000);
    const search = page.getByRole("textbox").first();
    await search.pressSequentially("design", { delay: 60 }).catch(() => {});
    await hold(page, 2500);
  });

  await step("Workspace: the files Amiro reads every turn — who it is, how it works, what it knows about you", async () => {
    await page.goto("/agent/workspace");
    for (const b of ["Identity", "You", "Heartbeat"]) {
      await page.getByRole("button", { name: b, exact: true }).click().catch(() => {});
      await page.waitForTimeout(1500);
    }
    await hold(page, 2000);
  });
});
