/**
 * Journey 7 — the agent's own pages: Personality, Memory, Workspace,
 * Superpowers (skills), and renaming/customising the agent.
 */
import { ask, newChat, selectModel } from "../support/chat";
import { expect, test } from "../support/fixtures";

test.describe("agent-hub", () => {
  test("personality: apply a preset, nudge a dial, update, persists", async ({ page, step }) => {
    await step("Agent hub → Personality", async () => {
      await page.goto("/agent");
      await page.locator("main").getByRole("link", { name: /Tune how I talk/ }).click();
      await expect(page).toHaveURL(/\/agent\/personality/);
      await expect(page.getByRole("heading", { name: "Shape my personality" })).toBeVisible();
    });
    await step("Pick the 'Warm Companion' preset", async () => {
      await page.getByRole("button", { name: "Warm Companion" }).click();
    });
    await step("Nudge 'Playful to Serious' with the keyboard", async () => {
      const s = page.getByRole("slider", { name: "Playful to Serious" });
      await s.focus();
      for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowLeft");
    });
    let summary = "";
    await step("Update personality → back on the Agent hub with the new signature", async () => {
      // Read the first trait ("78% Companion"); the sample label is CSS-uppercased.
      summary = (await page.getByText(/Illustrative tone sample · /).innerText()).split("·")[1].trim();
      await page.getByRole("button", { name: "Update personality" }).click();
      await expect(page).toHaveURL(/\/agent(\?|$)/, { timeout: 15000 });
      await expect(page.getByRole("link", { name: /Tune how I talk/ })).toContainText(new RegExp(summary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
    });
    await step("Reload: the saved signature persists", async () => {
      await page.reload();
      await expect(page.getByRole("link", { name: /Tune how I talk/ })).toContainText(new RegExp(summary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
    });
  });

  test("rename the agent from the hub", async ({ page, step, amiro }) => {
    const newName = `${amiro.cfg.agent.name}ette`;
    await step("Rename agent → new name", async () => {
      await page.goto("/agent");
      await page.getByRole("button", { name: "Rename agent" }).click();
      const box = page.getByRole("textbox").first();
      await box.fill(newName);
      await page.keyboard.press("Enter");
      await expect(page.getByRole("heading", { name: new RegExp(`Hi, I.m ${newName}`) })).toBeVisible();
    });
    await step("Sidebar shows the new name; then rename back", async () => {
      await expect(page.getByRole("link", { name: new RegExp(`${newName}.*Personality`) })).toBeVisible();
      await page.getByRole("button", { name: "Rename agent" }).click();
      await page.getByRole("textbox").first().fill(amiro.cfg.agent.name);
      await page.keyboard.press("Enter");
    });
  });

  test("memory: tell the agent a fact, it shows up in Memory", async ({ page, step }) => {
    await step("Tell the agent something to remember", async () => {
      await newChat(page);
      await selectModel(page);
      await ask(page, "Please remember this about me for the future: my favourite hiking trail is the Kalalau Trail.");
    });
    await step("Memory page lists it (cards view, search)", async () => {
      await page.goto("/agent/memory");
      await page.getByRole("button", { name: "Cards" }).click();
      await page.getByRole("textbox", { name: "Search memories" }).fill("Kalalau");
      await expect
        .poll(async () => (await page.locator("main").innerText()).includes("Kalalau"), { timeout: 180000, intervals: [5000] })
        .toBe(true)
        .catch(async () => {
          await page.reload();
          await page.getByRole("button", { name: "Cards" }).click();
          await expect.soft(page.getByText(/Kalalau/).first(), "memory should be saved after the conversation").toBeVisible({ timeout: 60000 });
        });
    });
    await step("A new chat recalls it", async () => {
      await newChat(page);
      const reply = await ask(page, "What is my favourite hiking trail?");
      expect.soft(reply).toMatch(/Kalalau/i);
    });
  });

  test("workspace: open identity files, create and edit a file", async ({ page, step }) => {
    await step("Agent hub → Workspace", async () => {
      await page.goto("/agent/workspace");
      await expect(page.getByRole("heading", { name: "Workspace", level: 1 })).toBeVisible();
    });
    await step("Open SOUL.md from the file tree", async () => {
      await page.getByRole("treeitem", { name: /SOUL\.md/ }).click();
      await expect(page.getByText("Nothing open yet")).toBeHidden();
    });
    await step("Agent-home shortcuts: Identity, You, Heartbeat", async () => {
      for (const b of ["Identity", "You", "Heartbeat"]) {
        await page.getByRole("button", { name: b, exact: true }).click();
        await page.waitForTimeout(600);
      }
    });
    await step("New file → e2e-notes.md with content", async () => {
      await page.getByRole("button", { name: "New file" }).click();
      const name = page.getByRole("dialog").getByRole("textbox").first().or(page.getByRole("textbox", { name: /name/i }).first());
      await name.fill("e2e-notes.md");
      await page.keyboard.press("Enter");
      await expect(page.getByRole("treeitem", { name: /e2e-notes\.md/ })).toBeVisible();
      const editor = page.locator("main [contenteditable=true], main textarea, main .cm-content").last();
      if (await editor.isVisible().catch(() => false)) {
        await editor.click();
        await page.keyboard.type("# Written by the E2E suite", { delay: 10 });
        await page.keyboard.press("Control+S");
      }
    });
  });

  test("superpowers: browse, search and open a skill", async ({ page, step }) => {
    await step("Agent hub → Superpowers lists built-in skills", async () => {
      await page.goto("/agent/superpowers");
      await expect(page.getByText(/visualize/i).first()).toBeVisible();
    });
    await step("Search for 'weather' and open it", async () => {
      const search = page.getByRole("textbox").first();
      await search.fill("weather");
      await page.getByText(/weather/i).first().click();
      await expect(page.getByText(/weather/i).first()).toBeVisible();
    });
    await step("Skills page (/skills) shows the same catalog", async () => {
      await page.goto("/skills");
      await expect(page.getByText(/visualize/i).first()).toBeVisible();
    });
  });

  test("interface language: switch to Hindi and back to English", async ({ page, step }) => {
    await step("User menu → Language lists only English and Hindi", async () => {
      await page.goto("/");
      await page.locator("[data-sidebar=footer] button, button").filter({ hasText: /@/ }).last().click();
      await page.getByRole("menuitem", { name: /Language/ }).click();
      await expect(page.getByRole("menuitemcheckbox", { name: /English/ })).toBeVisible();
      await expect(page.getByRole("menuitemcheckbox", { name: /हिन्दी/ })).toBeVisible();
      await expect(page.getByRole("menuitemcheckbox")).toHaveCount(2);
      await expect(page.getByText(/Korean|Español|Spanish|日本語|中文|Norwegian/)).toHaveCount(0);
    });
    await step("Choose हिन्दी → the UI switches to Hindi", async () => {
      await page.getByRole("menuitemcheckbox", { name: /हिन्दी/ }).click();
      await expect(page.getByText("नई चैट").first()).toBeVisible({ timeout: 15000 });
      await expect(page.locator("html")).toHaveAttribute("lang", "hi");
    });
    await step("Switch back to English", async () => {
      await page.locator("button").filter({ hasText: /@/ }).last().click();
      await page.getByRole("menuitem", { name: /भाषा|Language/ }).click();
      await page.getByRole("menuitemcheckbox", { name: /English/ }).click();
      await expect(page.getByText("New Chat").first()).toBeVisible({ timeout: 15000 });
    });
  });
});
