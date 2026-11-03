/**
 * Journey 7 — the agent's own pages: Personality, Memory, Workspace,
 * Superpowers (skills), and renaming/customising the agent.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { ask, newChat, selectModel } from "../support/chat";
import { DEFAULT_AGENT_NAME, STATE_FILE } from "../support/config";
import { expect, test } from "../support/fixtures";

/** The isolated instance's agent home, from the state global setup wrote. */
function workspaceDir(): string {
  const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as { root: string; sandbox?: { home: string } };
  return path.join(state.sandbox?.home ?? path.join(state.root, "home"), "workspace");
}

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

  test("rename the agent from the hub", async ({ page, step }) => {
    const newName = `${DEFAULT_AGENT_NAME}ette`;
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
      await page.getByRole("textbox").first().fill(DEFAULT_AGENT_NAME);
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

  test("Workspace history: Amiro files a note in notes/, indexes it, and the change is snapshotted so it can be undone", async ({ page, step, amiro }) => {
    // Planning Brew & Bloom's opening week: the supplier details are worth keeping.
    const history = () =>
      execFileSync("git", ["-C", workspaceDir(), "log", "--format=%s", "--name-only"], { encoding: "utf8" });
    let before = "";
    await step("Ask Amiro to keep the supplier details as a note", async () => {
      test.skip(!fs.existsSync(path.join(workspaceDir(), ".git")), "workspace history is checked on the isolated instance only");
      before = history();
      await newChat(page);
      await selectModel(page);
      await ask(
        page,
        "Save a note for me: our oat-milk supplier for Brew & Bloom is Oatly India, contact Priya Nair, delivers Tuesdays and Fridays before 7am. Keep it in your notes and add it to the notes index.",
      );
    });
    await step("The note is in notes/ and listed in notes/INDEX.md", async () => {
      const { body: tree } = await amiro.api<{ entries?: Array<{ name: string }> }>("/api/workspace/tree?path=notes");
      const notes = (tree.entries ?? []).map((entry) => entry.name).filter((name) => name !== "INDEX.md");
      expect.soft(notes, "a new note file next to the index").not.toHaveLength(0);
      const { body } = await amiro.api<{ content?: string }>("/api/workspace/file?path=notes/INDEX.md");
      expect.soft(body.content ?? "", "the index lists the new note").toMatch(/supplier|oat|Oatly/i);
    });
    await step("The turn left a snapshot: the note is in the workspace history, ready to restore", async () => {
      await expect
        .poll(() => history().length, { timeout: 15000, message: "a snapshot after the turn" })
        .toBeGreaterThan(before.length);
      const log = history();
      expect(log, "the snapshot is named after the chat").toMatch(/^Chat: /m);
      expect(log, "the new note is in the snapshot").toMatch(/^notes\/.+\.md$/m);
    });
    await step("Workspace page: notes/ shows the new note", async () => {
      await page.goto("/agent/workspace");
      await page.getByRole("treeitem", { name: /^notes/ }).click();
      await expect(page.getByRole("treeitem", { name: /INDEX\.md/ })).toBeVisible();
    });
  });

  test("workspace: open identity files, create and edit a file", async ({ page, step, amiro }) => {
    await step("Agent hub → Workspace", async () => {
      await page.goto("/agent/workspace");
      await expect(page.getByRole("heading", { name: "Workspace", level: 1 })).toBeVisible();
    });
    await step("Open SOUL.md from the file tree", async () => {
      await page.getByRole("treeitem", { name: /SOUL\.md/ }).click();
      await expect(page.getByText("Nothing open yet")).toBeHidden();
    });
    await step("Workspace folders: the home has journal, notes (with its index), scripts and scratch", async () => {
      for (const dir of ["journal", "notes", "scripts", "scratch"]) {
        await expect(page.getByRole("treeitem", { name: new RegExp(`^${dir}`) }), `${dir}/ is in the tree`).toBeVisible();
      }
      await expect(page.getByRole("treeitem", { name: /^\.git/ }), "the history folder stays out of sight").toHaveCount(0);
      const { status, body } = await amiro.api<{ content?: string }>("/api/workspace/file?path=notes/INDEX.md");
      expect(status).toBe(200);
      expect(body.content, "the notes index is seeded").toContain("# Notes");
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

  test("superpowers: Vellum-ported skills appear with display names", async ({ page, step }) => {
    await step("Search for 'frontend design' → Frontend Design card", async () => {
      await page.goto("/agent/superpowers");
      const search = page.getByTestId("superpowers-search-input");
      await search.fill("frontend design");
      await expect(page.getByTestId("skill-card").filter({ hasText: "Frontend Design" }).first()).toBeVisible();
    });
    await step("Search for 'geo' → GEO Article Writer card", async () => {
      const search = page.getByTestId("superpowers-search-input");
      await search.fill("geo");
      await expect(page.getByTestId("skill-card").filter({ hasText: "GEO Article Writer" }).first()).toBeVisible();
    });
    await step("Search for 'cli' → CLI Discovery card", async () => {
      const search = page.getByTestId("superpowers-search-input");
      await search.fill("cli");
      await expect(page.getByTestId("skill-card").filter({ hasText: "CLI Discovery" }).first()).toBeVisible();
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

  test("channels and contacts: navigate, configure channel policy, create and verify contact", async ({ page, step }) => {
    await step("Navigate to Channels page (/channels)", async () => {
      await page.goto("/channels");
      await expect(page.locator("[data-testid=channels-page]")).toBeVisible();
      await expect(page.getByRole("heading", { name: "Channels" })).toBeVisible();
      await expect(page.locator("[data-testid=channels-back-link]")).toBeVisible();
    });

    await step("Change Telegram admission policy to 'Verified contacts'", async () => {
      await page.locator("[data-testid=channel-row-telegram]").click();
      await page.locator("[data-testid=channel-policy-select]").click();
      await page.getByRole("option", { name: /Verified contacts/i }).click();
      await expect(page.locator("[data-testid=channel-policy-select]")).toContainText(/Verified contacts/i);
    });

    await step("Click Back to Agent Hub from Channels", async () => {
      await page.locator("[data-testid=channels-back-link]").click();
      await expect(page).toHaveURL(/\/agent(\?|$)/);
    });

    await step("Navigate to Contacts page (/contacts)", async () => {
      await page.goto("/contacts");
      await expect(page.locator("[data-testid=contacts-page]")).toBeVisible();
      await expect(page.getByRole("heading", { name: "Contacts" })).toBeVisible();
      await expect(page.locator("[data-testid=contacts-back-link]")).toBeVisible();
    });

    await step("Create a new contact 'Bob Smith' with Telegram address", async () => {
      await page.locator("[data-testid=add-contact-button]").click();
      await page.locator("[data-testid=new-contact-name-input]").fill("Bob Smith");
      await page.locator("[data-testid=save-new-contact-button]").click();
      await expect(page.locator("[data-testid=contact-detail-card]")).toContainText("Bob Smith");
    });

    await step("Add a Telegram account to Bob Smith → Verify needs proof, never a free tick", async () => {
      await page.locator("[data-testid=add-channel-address-input]").fill("@bob_telegram");
      await page.locator("[data-testid=add-channel-button]").click();
      await expect(page.getByText("@bob_telegram")).toBeVisible();

      // Verification sends a code through the channel's bot (journey 14
      // walks the whole code flow). An @username cannot receive one, so
      // Amiro says what is needed instead of marking it verified.
      await page.getByTestId("verify-channel-telegram").click();
      await expect(
        page.getByText(/Connect the Telegram bot on the Channels page|numeric user id/).first(),
      ).toBeVisible();
      await expect(page.getByTestId("verify-channel-telegram")).toBeVisible();
    });

    await step("Agent hub reflects Channels and Contacts bottom strip tiles", async () => {
      await page.goto("/agent");
      await expect(page.locator("[data-testid=agent-card-channels]")).toBeVisible();
      await expect(page.locator("[data-testid=agent-card-contacts]")).toBeVisible();
    });
  });
});
