/**
 * Journey 4 — chatting with the configured model: rich rendering (tables,
 * code, mermaid, inline visuals), tool calling (web search), swarm
 * delegation, skills, follow-up queue, message actions and thread management.
 *
 * Model output varies, so render checks are soft (`expect.soft`): the test is
 * marked failed but the journey keeps going and the video keeps recording.
 */
import { ask, assistantMessages, chatErrors, composer, newChat, selectModel, send, toolCallsShown, waitForReply } from "../support/chat";
import { expect, test } from "../support/fixtures";
import * as fs from "node:fs";

test.describe("chat", () => {
  test.beforeEach(async ({ page }) => {
    await newChat(page);
    await selectModel(page);
  });

  test("markdown: table, code block and mermaid diagram render", async ({ page, step }) => {
    await step("Ask for a markdown table", async () => {
      await ask(page, "Give me a markdown table of the 3 largest planets with columns Planet, Diameter (km), Moons. Table only.");
      const table = assistantMessages(page).last().locator("table");
      await expect.soft(table, "assistant reply should render an HTML table").toBeVisible();
      await expect.soft(table.locator("tr"), "header + 3 rows").toHaveCount(4);
    });

    await step("Ask for a code block → syntax-highlighted with a copy button", async () => {
      await ask(page, "Show a 5-line Python function that reverses a string, in a fenced code block. Code only.");
      const pre = assistantMessages(page).last().locator("pre").first();
      await expect.soft(pre).toBeVisible();
      await pre.hover();
    });

    await step("Ask for a mermaid flowchart → rendered as a diagram, not raw text", async () => {
      await ask(page, "Reply with only a mermaid flowchart (```mermaid fenced) of: Login -> Dashboard -> Settings.");
      const last = assistantMessages(page).last();
      await expect.soft(last.locator("svg").first(), "mermaid should render to SVG").toBeVisible({ timeout: 30000 });
    });
  });

  test("tool calling: web search with sources", async ({ page, step, note }) => {
    let reply = "";
    await step("Ask a question that needs the web", async () => {
      reply = await ask(page, "Search the web: what is the latest stable version of the Rust programming language? Cite the source URL.");
    });
    await step("A search tool call is shown in the transcript, and the answer cites a source", async () => {
      const transcript = await toolCallsShown(page);
      expect.soft(transcript, "a web search tool call should be visible").toMatch(/search|web_fetch|fetch/i);
      expect.soft(reply, "answer should include a URL").toMatch(/https?:\/\/|\.org|\.com|rust-lang/i);
      const links = await assistantMessages(page).last().locator("a[href^='http']").count();
      if (!links) note("Web search answer has no clickable source link.");
    });
    await step("Web search UI: sources sit above the answer as numbered cards, and the folded timeline keeps their favicons", async () => {
      const strip = page.getByTestId("message-web-sources-bar").last();
      await expect.soft(strip, "sources strip shows above the answer").toBeVisible({ timeout: 30000 });
      const cards = strip.getByTestId("source-card");
      expect.soft(await cards.count(), "at least one source card").toBeGreaterThan(0);
      await expect.soft(cards.first(), "a source card is a real link").toHaveAttribute("href", /^https?:\/\//);
      const fold = page.getByTestId("work-summary").last();
      await expect.soft(fold, "the search run folded once the answer came").toHaveAttribute("data-state", "settled");
      await expect
        .soft(
          page
            .locator('[data-message-role="assistant"]')
            .last()
            .locator('[data-testid="reasoning-part"]:not([data-testid="work-summary"] [data-testid="reasoning-part"])'),
          "thinking after the search stays inside the card, never in the answer",
        )
        .toHaveCount(0);
      await fold.locator("> button").click();
      await expect.soft(page.getByTestId("worklog-timeline").last(), "the timeline lists the search step").toContainText(/Searched|Read /);
      await fold.locator("> button").click();
    });
    await step("Open the Tools menu in the chat header", async () => {
      const tools = page.getByRole("button", { name: "Tools" });
      if (await tools.isVisible()) {
        await tools.click();
        await page.waitForTimeout(800);
        await page.keyboard.press("Escape");
      }
    });
  });

  test("ask-user question card: the agent asks, the user picks, the answer is sent", async ({ page, step }) => {
    const card = page.getByTestId("ask-user-card").last();
    await step("Ask the agent to check a choice with me first → a question card appears", async () => {
      // The turn may end with the card alone and no prose, so wait for the
      // card itself rather than for a text reply.
      await send(
        page,
        "Use the ui_ask_user tool to ask me one question: which colour theme I want, with the options Light and Dark. Then stop and wait for my answer.",
      );
      await expect(card, "the agent's question renders as a card").toBeVisible({ timeout: 180000 });
      await expect
        .soft(page.locator('[data-testid="work-summary"][data-state="running"]'), "the turn ends after asking")
        .toHaveCount(0, { timeout: 120000 });
      await expect.soft(card).toHaveAttribute("data-state", "open");
      await expect.soft(card.getByTestId("ask-user-option"), "the options are listed").toHaveCount(2);
      await expect.soft(card.getByTestId("ask-user-other"), "an Other answer is offered").toBeVisible();
    });
    await step("Pick Dark with the keyboard-numbered option and send → the answer goes out as my message", async () => {
      await card.getByTestId("ask-user-option").filter({ hasText: /Dark/i }).click();
      await expect.soft(card.getByTestId("ask-user-option").filter({ hasText: /Dark/i })).toHaveAttribute("aria-checked", "true");
      const before = await assistantMessages(page).count();
      await card.getByTestId("ask-user-send").click();
      await expect(page.locator('[data-message-role="user"]').last(), "the picks are sent as the user's reply").toContainText(/Dark/, { timeout: 15000 });
      await waitForReply(page, { before, timeoutMs: 180000 });
      await expect.soft(page.getByTestId("ask-user-card").first(), "the asked card is now read-only").toHaveAttribute("data-state", "answered");
      expect.soft(await assistantMessages(page).last().innerText(), "the agent acts on the answer").toMatch(/dark/i);
    });
  });

  test("plan, tasks and walkthrough: plan with a line comment, revised, approved, tasks, walkthrough", async ({ page, step }) => {
    const plan = page.getByTestId("plan-view");
    await step("Brew & Bloom: ask for a launch plan first → the Plan tab opens with the plan awaiting review", async () => {
      await send(
        page,
        "I am launching Brew & Bloom, an oat-milk café in Koregaon Park, Pune. Use the ui_propose_plan tool to show me a short launch plan (Goal, Steps, Risks) and stop to wait for my review. Do not start the work.",
      );
      await expect(plan, "the plan renders in the artifact pane").toBeVisible({ timeout: 240000 });
      await expect(plan).toHaveAttribute("data-state", "pending", { timeout: 120000 });
      await expect.soft(page.getByTestId("artifact-tab-plan")).toHaveAttribute("data-active", "true");
    });
    await step("Comment on one line of the plan → it is listed, then Send comments → the plan is revised", async () => {
      await plan.locator("li, p").filter({ hasText: /\w{4}/ }).nth(1).hover();
      await page.getByTestId("plan-comment-line").click();
      await page.getByTestId("plan-comment-input").fill("Add a soft-opening week with friends and family before the public launch.");
      await page.getByTestId("plan-comment-submit").click();
      await expect(page.getByTestId("plan-comment")).toHaveCount(1);
      await page.getByTestId("plan-review-toggle").click();
      const before = await assistantMessages(page).count();
      await page.getByTestId("plan-send-comments").click();
      await expect(page.locator('[data-message-role="user"]').last(), "the comment is sent quoting the line").toContainText(/Changes requested/, { timeout: 15000 });
      await waitForReply(page, { before, timeoutMs: 240000 });
      await expect(plan, "the revised plan awaits review again").toHaveAttribute("data-state", "pending", { timeout: 120000 });
    });
    await step("Approve → the pane moves to Tasks (plain todos), then to the Walkthrough when the work is done", async () => {
      await page.getByTestId("plan-proceed").click();
      await expect(page.getByTestId("todo-panel"), "tasks follow the approval").toBeVisible({ timeout: 240000 });
      await expect(page.getByTestId("walkthrough-view"), "the walkthrough closes the work").toBeVisible({ timeout: 360000 });
      await expect.soft(page.getByTestId("artifact-tab-walkthrough")).toHaveAttribute("data-active", "true");
    });
  });

  test("thinking-only reply folds into a Thought card, prompt spacing", async ({ page, step }) => {
    await step("Ask something that needs only thinking → the thinking lives in the card and folds to 'Thought'", async () => {
      await ask(page, "Think it through step by step first, then answer with just the number: what is 17 * 23? Do not use any tools.");
      const fold = page.getByTestId("work-summary").last();
      await expect.soft(fold, "thinking-only replies get the card too").toBeVisible();
      await expect.soft(fold).toHaveAttribute("data-state", "settled");
      await expect.soft(fold.locator("> button"), "folded label says Thought").toContainText(/Thought/);
      await expect.soft(assistantMessages(page).last()).toContainText("391");
    });
    await step("More space above my prompt than below it", async () => {
      const prompt = page.locator('[data-message-role="user"]').last();
      const above = page.locator("[data-message-id]").nth(-3);
      const reply = page.locator('[data-message-role="assistant"]').last();
      const [p, a, r] = await Promise.all([prompt.boundingBox(), above.boundingBox(), reply.boundingBox()]);
      if (p && a && r) {
        const gapAbove = p.y - (a.y + a.height);
        const gapBelow = r.y - (p.y + p.height);
        expect.soft(gapAbove, "gap above the prompt is larger than below").toBeGreaterThan(gapBelow);
      }
    });
  });

  test("visualize skill renders an inline visual", async ({ page, step }) => {
    await step("Ask for a chart", async () => {
      await ask(page, "Use the visualize skill: draw an inline bar chart of monthly sales Jan 10, Feb 14, Mar 9, Apr 17.", {
        timeoutMs: 240000,
      });
    });
    await step("A visual (iframe/svg/canvas) is rendered inline in the reply", async () => {
      const visual = page.locator("main iframe, main article svg, main article canvas").first();
      await expect.soft(visual, "inline visual should render").toBeVisible({ timeout: 60000 });
      await expect.soft(page.getByRole("status", { name: /Rendering visual/ }), "placeholder should be replaced").toHaveCount(0);
    });
  });

  test("openui generative ui: daily executive command center, interactive cloud cost planner and sprint release tracker", async ({ page, step, amiro }) => {
    await step("Greeting screen shows quick-launch OpenUI demo pills → click Daily Command Center", async () => {
      await newChat(page);
      const starterStrip = page.getByTestId("openui-starter-strip");
      await expect(starterStrip).toBeVisible();
      await expect(page.getByTestId("openui-starter-daily_brief")).toBeVisible();
      await expect(page.getByTestId("openui-starter-budget_planner")).toBeVisible();
      await expect(page.getByTestId("openui-starter-sprint_tracker")).toBeVisible();
      await expect(page.getByTestId("openui-starter-agent_data_intake")).toBeVisible();
      await page.waitForTimeout(800);
      await page.getByTestId("openui-starter-daily_brief").click();
      await waitForReply(page, { timeoutMs: 240000 });
    });

    await step("Daily Command Center renders live KPI cards, Recharts bar chart, filterable Service Matrix tab, and Today's Focus steps", async () => {
      const surface = page.getByTestId("openui-surface").first();
      await expect(surface).toBeVisible({ timeout: 30000 });
      await expect(surface.getByTestId("openui-metric-card")).toHaveCount(4);
      await expect(surface.getByTestId("openui-bar-chart")).toBeVisible();
      await page.waitForTimeout(1000);

      // Switch to Service Matrix tab and filter rows
      await surface.getByTestId("openui-tab-1").click();
      await expect(surface.getByTestId("openui-data-table")).toBeVisible();
      await page.waitForTimeout(800);
      const filterInput = surface.getByTestId("openui-table-filter");
      await filterInput.fill("Degraded");
      await expect(surface.getByTestId("openui-table-row")).toHaveCount(1);
      await page.waitForTimeout(800);
      await filterInput.fill("");
      await expect(surface.getByTestId("openui-table-row")).toHaveCount(4);

      // Switch to Today's Focus tab (Steps)
      await surface.getByTestId("openui-tab-2").click();
      await expect(surface.getByTestId("openui-steps")).toBeVisible();
      await page.waitForTimeout(900);
    });

    await step("Ask for the interactive Cloud AI Cost & Capacity Planner and adjust live workload sliders", async () => {
      await ask(
        page,
        'Use the ui_render_openui tool on the amiro MCP server with preset="budget_planner" to render the Cloud AI Cost & Capacity Planner, then summarize how hybrid routing lowers spend in one sentence.',
        { timeoutMs: 240000 },
      );
      const budgetSurface = page.getByTestId("openui-surface").last();
      await expect(budgetSurface).toBeVisible({ timeout: 30000 });
      const form = budgetSurface.getByTestId("openui-interactive-form");
      await expect(form).toBeVisible({ timeout: 30000 });

      const spendBefore = await form.getByTestId("openui-simulated-spend").textContent();
      const rpmSlider = form.getByTestId("openui-slider-requests_per_day");
      await rpmSlider.fill("380");
      await rpmSlider.dispatchEvent("change");
      await page.waitForTimeout(800);

      const cacheSlider = form.getByTestId("openui-slider-cache_target");
      await cacheSlider.fill("84");
      await cacheSlider.dispatchEvent("change");
      await page.waitForTimeout(800);

      const spendAfter = await form.getByTestId("openui-simulated-spend").textContent();
      expect.soft(spendAfter).not.toBe(spendBefore);
    });

    await step("Agent asks an interactive question, user pastes service values, and pastes an API key/password into the encrypted vault card", async () => {
      const WEBHOOK_SECRET = "whsec_live_E2eOpenUIVaultSecret9876543210";
      await ask(
        page,
        'Use the ui_render_openui tool on the amiro MCP server with preset="agent_data_intake" to render the Interactive Deployment & Credential Intake surface, then wait for my inputs.',
        { timeoutMs: 240000 },
      );

      const intakeSurface = page.getByTestId("openui-surface").last();
      await expect(intakeSurface).toBeVisible({ timeout: 30000 });

      // 1. User interactively selects an option in QuestionCard and adds a constraint note
      const qCard = intakeSurface.getByTestId("openui-question-card");
      await expect(qCard).toBeVisible({ timeout: 30000 });
      await qCard.getByTestId("openui-question-option-1").click();
      await page.waitForTimeout(600);
      await qCard.getByTestId("openui-question-option-0").click();
      await qCard.getByTestId("openui-question-note").fill("Hold 10% canary for 30 minutes before 50% shift");
      await page.waitForTimeout(800);

      // 2. User pastes endpoint URL and multi-line ENV/JSON values into the intake form
      const intakeForm = intakeSurface.getByTestId("openui-interactive-form");
      await expect(intakeForm).toBeVisible();
      await intakeForm.getByTestId("openui-input-webhook_url").fill("https://hooks.amiro.internal/v2/deploy-gate");
      await intakeForm.getByTestId("openui-select-target_region").selectOption("eu-west1 (Belgium)");
      await intakeForm
        .getByTestId("openui-textarea-config_snippet")
        .fill("RELEASE_VERSION=v1.27.0\nCANARY_WEIGHT=10\nMAX_P95_MS=180");
      await page.waitForTimeout(900);

      // 3. User pastes an API key / signing secret into the embedded encrypted SecretVaultCard
      const vaultCard = intakeSurface.getByTestId("secret-prompt-card");
      await expect(vaultCard).toBeVisible();
      const secretInput = vaultCard.getByTestId("secret-prompt-input");
      await expect(secretInput).toHaveAttribute("type", "password");
      await secretInput.fill(WEBHOOK_SECRET);
      await page.waitForTimeout(700);
      await vaultCard.getByTestId("secret-prompt-save").click();
      await expect(vaultCard.getByTestId("secret-prompt-saved")).toBeVisible({ timeout: 30000 });
      await waitForReply(page, { before: 0, timeoutMs: 240000 });

      // 4. Verify the secret is stored in the encrypted vault and never leaked into chat
      expect(await page.locator("main").innerText()).not.toContain(WEBHOOK_SECRET);
      const { body } = await amiro.api("/api/credentials");
      expect(JSON.stringify(body)).toMatch(/release-webhook/i);
      expect(JSON.stringify(body)).not.toContain(WEBHOOK_SECRET);
    });

    await step("User submits the pasted deployment values from the OpenUI form and the agent responds", async () => {
      const intakeSurface = page.getByTestId("openui-surface").last();
      const intakeForm = intakeSurface.getByTestId("openui-interactive-form");
      const beforeCount = await assistantMessages(page).count();
      await intakeForm.getByTestId("openui-form-submit").click();
      await expect(intakeForm.getByTestId("openui-form-submitted-badge")).toBeVisible();
      await waitForReply(page, { before: beforeCount, timeoutMs: 240000 });
    });
  });

  test("swarm: the agent delegates sub-tasks and shows them", async ({ page, step, note }) => {
    await step("Ask for parallel work", async () => {
      await send(
        page,
        "Spawn two sub-agents in parallel: one lists 3 facts about Mars, the other 3 facts about Venus. Then merge their results into one short answer.",
      );
    });
    await step("Delegation / swarm UI appears while it works", async () => {
      const swarm = page.getByText(/Delegating|Swarm ·/).first();
      const seen = await swarm.waitFor({ timeout: 120000 }).then(() => true, () => false);
      expect.soft(seen, "swarm/delegation indicator should appear").toBe(true);
      const strip = page.getByRole("listbox", { name: "Swarm agents" });
      if (await strip.isVisible().catch(() => false)) {
        await strip.getByRole("option").first().click().catch(() => {});
        await page.waitForTimeout(1500);
        await page.getByRole("button", { name: "Close agent peek" }).click().catch(() => {});
      } else note("No 'Swarm agents' strip was shown for a parallel sub-agent request.");
    });
    await step("Final merged answer mentions both planets", async () => {
      const reply = await waitForReply(page, { timeoutMs: 300000 });
      expect.soft(reply).toMatch(/Mars/i);
      expect.soft(reply).toMatch(/Venus/i);
    });
  });

  test("composer: / runs the runtime's commands and lists skills, @ finds files", async ({ page, step, amiro }) => {
    await step("Type / in an empty composer → jcode's commands, then skills", async () => {
      await newChat(page);
      await composer(page).click();
      await page.keyboard.type("/", { delay: 40 });
      const palette = page.getByTestId("skill-palette");
      await expect(palette).toBeVisible();
      await expect(palette.getByTestId("skill-palette-group-commands")).toBeVisible();
      for (const command of ["compact", "context", "info", "memory", "mcp"]) {
        await expect(palette.getByTestId(`skill-palette-command-${command}`)).toBeVisible();
      }
      await expect(palette.getByTestId("skill-palette-loading")).toBeHidden({ timeout: 15000 });
      await expect(palette.getByTestId("skill-palette-item-visualize")).toBeVisible();
    });

    await step("Narrow to /vis → pick the visualize skill → chip in the composer", async () => {
      await page.keyboard.type("vis", { delay: 40 });
      const palette = page.getByTestId("skill-palette");
      await expect(palette.locator('[data-testid^="skill-palette-command-"]')).toHaveCount(0);
      await palette.getByTestId("skill-palette-item-visualize").click();
      await expect(page.locator('[data-testid^="skill-chip-"]').first()).toBeVisible();
    });

    await step("A command on a chat that has not started says so, without sending anything", async () => {
      await page.keyboard.press("Control+A");
      await page.keyboard.press("Backspace");
      await page.keyboard.type("/context", { delay: 30 });
      await page.keyboard.press("Enter");
      const result = page.getByTestId("command-result");
      await expect(result).toHaveAttribute("data-status", "error", { timeout: 15000 });
      await expect(result).toContainText("Send a message first");
      await expect(assistantMessages(page)).toHaveCount(0);
      await page.getByTestId("command-result-close").click();
    });

    await step("Ask something, then /context → the runtime's own answer, not a chat message", async () => {
      await ask(page, "Reply with one short sentence about lighthouses.");
      const before = await assistantMessages(page).count();
      await composer(page).click();
      await page.keyboard.type("/con", { delay: 30 });
      await page.getByTestId("skill-palette-command-context").click();
      const result = page.getByTestId("command-result");
      await expect(result).toHaveAttribute("data-status", "done", { timeout: 30000 });
      // A short readable summary, not the runtime's raw JSON.
      await expect(page.getByTestId("command-result-text")).toContainText("Context window:");
      await expect(page.getByTestId("command-result-text")).not.toContainText("{");
      expect(await assistantMessages(page).count()).toBe(before);
      await expect(composer(page)).toHaveText("");
    });

    await step("/compact → the runtime compacts, or says why it cannot yet", async () => {
      await composer(page).click();
      await page.keyboard.type("/compact", { delay: 30 });
      await page.keyboard.press("Enter");
      const result = page.getByTestId("command-result");
      await expect(result).not.toHaveAttribute("data-status", "running", { timeout: 30000 });
      // A short chat is below the runtime's threshold; its own reason shows,
      // without the wire code in front of it.
      if ((await result.getAttribute("data-status")) === "error") {
        await expect(page.getByTestId("command-result-text")).toContainText(/Cannot compact/);
        await expect(page.getByTestId("command-result-text")).not.toContainText("invalid_request");
      }
      await page.getByTestId("command-result-close").click();
    });

    await step("Type @ → only files and folders in the chat's folder, no tools", async () => {
      const { status } = await amiro.api("/api/workspace/write", {
        method: "POST",
        body: JSON.stringify({ path: "e2e-mentions/launch-plan.md", content: "# Launch plan\n" }),
      });
      expect(status).toBeLessThan(300);
      await composer(page).click();
      await page.keyboard.type("@", { delay: 40 });
      const mentions = page.getByTestId("chat-mention-suggestion");
      await expect(mentions).toBeVisible();
      await expect(mentions.getByTestId("chat-mention-group-files")).toBeVisible({ timeout: 15000 });
      await expect(mentions).not.toContainText(/MCP tools|App tools/);
      await expect(mentions.locator('[data-testid^="chat-mention-item-"]')).toHaveCount(0);
    });

    await step("Search e2e-men → the folder is offered → picking it inserts @folder/", async () => {
      await page.keyboard.type("e2e-men", { delay: 40 });
      const mentions = page.getByTestId("chat-mention-suggestion");
      await mentions.getByTestId("chat-mention-folder-e2e-mentions").click();
      await expect(composer(page)).toContainText("@e2e-mentions/");
    });

    await step("@ again → search launch → picking the file inserts its path", async () => {
      await page.keyboard.type("@", { delay: 40 });
      await page.keyboard.type("launch", { delay: 40 });
      const mentions = page.getByTestId("chat-mention-suggestion");
      await mentions.getByTestId("chat-mention-file-e2e-mentions/launch-plan.md").click();
      await expect(composer(page)).toContainText("@e2e-mentions/launch-plan.md");
    });
  });

  test("follow-up queue, message actions and threads", async ({ page, step }) => {
    await step("Send a long request, then queue a follow-up while it is still answering", async () => {
      await send(page, "Write a 300-word story about a lighthouse keeper.");
      await expect(page.getByText(/^Working…/).or(assistantMessages(page).first())).toBeVisible({ timeout: 60000 });
      await send(page, "Now give it a title.");
      await expect.soft(page.getByTestId("queued-followup-chip"), "follow-up should be queued").toBeVisible({ timeout: 5000 });
    });
    await step("Both turns complete in order", async () => {
      await expect.poll(() => assistantMessages(page).count(), { timeout: 240000 }).toBeGreaterThanOrEqual(2);
      await waitForReply(page, { before: 1 });
    });
    await step("Hover the reply: copy and read-aloud actions exist", async () => {
      await assistantMessages(page).last().hover();
      await expect.soft(page.getByTestId("message-read-aloud-button").last()).toBeVisible();
    });
    await step("Hover my prompt: copy is offered, and there is no edit action", async () => {
      const userMsg = page.locator('[data-message-role="user"]').last();
      await userMsg.hover();
      await expect.soft(userMsg.getByTestId("message-copy-button"), "prompt can be copied").toBeVisible();
      await expect.soft(userMsg.getByRole("button", { name: /edit/i }), "prompts are not editable").toHaveCount(0);
      await expect.soft(page.getByTestId("message-editor-text")).toHaveCount(0);
    });
    await step("The conversation appears in Recent Chats with a generated title", async () => {
      await page.getByTestId("sidebar-switch-conversations").first().click();
      const thread = page.locator('a[href*="?thread="]').first();
      await expect.soft(thread, "a sidebar link to the conversation").toBeVisible({ timeout: 30000 });
    });
    await step("On a phone: the chat just used is on top; tapping an older chat opens it and closes the sidebar", async () => {
      // A second, newer conversation so there is an older one to go back to.
      await newChat(page);
      await ask(page, "Say hi in three words.");
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByTestId("sidebar-toggle").click();
      const sheet = page.locator('[data-mobile="true"]');
      await expect(sheet).toBeVisible();
      await sheet.getByTestId("sidebar-switch-conversations").click();
      const links = sheet.getByTestId("sidebar-thread-link");
      await expect.poll(() => links.count(), { timeout: 30000 }).toBeGreaterThanOrEqual(2);
      const newest = new URL((await links.first().getAttribute("href"))!, page.url()).searchParams.get("thread");
      expect(newest, "the chat just used is first").toBe(new URL(page.url()).searchParams.get("thread"));
      const older = links.nth(1);
      const olderId = new URL((await older.getAttribute("href"))!, page.url()).searchParams.get("thread");
      await older.click();
      await expect(page).toHaveURL(new RegExp(`thread=${olderId}`));
      await expect(sheet, "the sidebar closes to show the chat").toBeHidden();
      await expect(assistantMessages(page).first()).toBeVisible();
      const reply = await assistantMessages(page).first().boundingBox();
      expect(reply?.width ?? 0, "the chat gets the phone's width, not a sliver beside a side panel").toBeGreaterThan(250);
      await page.setViewportSize({ width: 1440, height: 900 });
    });
    await step("Start a new chat with the keyboard shortcut", async () => {
      await page.keyboard.press("Control+Shift+O");
      await expect(page).toHaveURL(/\/amiro\/?\??$/);
    });
  });

  test("phone locks mid-answer: the reply keeps going and comes back, Stop still stops", async ({ page, step }) => {
    // A phone drops the streaming request when the screen locks or the user
    // switches apps. The turn must keep running on the server and the chat
    // must pick it back up, never show it as failed.
    const plan =
      "Plan a relaxed Saturday in Pune for two: breakfast, a morning walk, lunch, an afternoon museum and dinner. " +
      "Give each stop a time, a place and one line on why. About 250 words.";
    const errorsBefore = await chatErrors(page).count();

    await step("Ask for a day plan; the answer starts streaming", async () => {
      await send(page, plan);
      await expect(assistantMessages(page).first()).toBeVisible({ timeout: 120000 });
      await expect.poll(async () => (await assistantMessages(page).last().innerText()).length, { timeout: 120000 }).toBeGreaterThan(20);
    });

    await step("The page goes away mid-answer (reload, like a phone coming back) → the reply carries on", async () => {
      await page.reload();
      await expect(composer(page)).toBeVisible({ timeout: 30000 });
      const reply = await waitForReply(page);
      expect(reply.length, "the full plan arrives after the reconnect").toBeGreaterThan(400);
      await expect(chatErrors(page), "a dropped stream is not a failed turn").toHaveCount(errorsBefore);
      await expect(page.locator('[data-message-role="user"]'), "the question is not sent twice").toHaveCount(1);
    });

    await step("The network drops mid-answer → back online, the reply finishes", async () => {
      const before = await assistantMessages(page).count();
      await send(page, "Now add a rainy-day backup for the walk and the museum, in about 120 words.");
      await expect.poll(() => assistantMessages(page).count(), { timeout: 120000 }).toBeGreaterThan(before);
      await page.context().setOffline(true);
      await page.waitForTimeout(3000);
      await page.context().setOffline(false);
      const reply = await waitForReply(page, { before });
      expect.soft(reply.length, "the backup plan arrives").toBeGreaterThan(150);
      await expect.soft(chatErrors(page)).toHaveCount(errorsBefore);
    });

    await step("Away until long after the reply ended (nothing left to replay) → the saved reply loads from history, no error", async () => {
      const before = await assistantMessages(page).count();
      await send(page, "One more: suggest a dessert place near the museum, in two sentences.");
      await expect.poll(() => assistantMessages(page).count(), { timeout: 120000 }).toBeGreaterThan(before);
      // The server forgot the finished turn: only its history has the reply.
      await page.route("**/api/chat/*/run", (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: '{"state":"none"}' }),
      );
      await page.context().setOffline(true);
      await page.waitForTimeout(45000);
      await page.context().setOffline(false);
      const reply = await waitForReply(page, { before });
      expect(reply, "the saved reply is shown in full").toMatch(/\w+[.!?]/);
      await expect(chatErrors(page), "no error is left on screen").toHaveCount(errorsBefore);
      await page.unroute("**/api/chat/*/run");
    });

    await step("Stop still stops: the reply ends and does not come back after a reload", async () => {
      const before = await assistantMessages(page).count();
      await send(page, "Write a 600-word story about the day, told by the museum guide.");
      await expect.poll(() => assistantMessages(page).count(), { timeout: 120000 }).toBeGreaterThan(before);
      await page.getByTestId("chat-send-button").click();
      await page.waitForTimeout(2000);
      const stopped = await assistantMessages(page).last().innerText();
      await page.waitForTimeout(4000);
      expect.soft(await assistantMessages(page).last().innerText(), "nothing more streams in after Stop").toBe(stopped);
      await page.reload();
      await expect(composer(page)).toBeVisible({ timeout: 30000 });
      await page.waitForTimeout(5000);
      const after = (await assistantMessages(page).last().innerText()).length;
      expect.soft(after, "the stopped story is not resumed").toBeLessThan(stopped.length + 200);
    });
  });

  test("file artifacts: create, preview and delete from the Files tab", async ({ page, step }) => {
    await step("Say hi so the thread exists, then open File artifacts from the toolbar", async () => {
      await send(page, "Reply with exactly: ready");
      await waitForReply(page);
      await page.getByTestId("artifacts-open").click();
      await expect(page.getByTestId("artifacts-panel")).toBeVisible();
    });
    await step("Create a markdown artifact with the + button", async () => {
      await page.getByTestId("artifacts-new").click();
      await page.getByTestId("artifact-create-title").fill("E2E report");
      await page.getByTestId("artifact-create-filename").fill("e2e-report.md");
      await page
        .getByTestId("artifact-create-content")
        .fill("# E2E report\n\nHello artifacts.");
      await page.getByTestId("artifact-create-submit").click();
      const item = page.locator('[data-testid^="artifact-item-"]').first();
      await expect(item, "new artifact appears in the list").toBeVisible({ timeout: 15000 });
    });
    await step("Select it → the markdown previews inline", async () => {
      await page.locator('[data-testid^="artifact-item-"]').first().click();
      await expect(page.getByTestId("artifact-viewer").getByTestId("workspace-markdown")).toContainText("Hello artifacts.", { timeout: 15000 });
    });
    await step("Delete it → the list is empty again", async () => {
      await page.getByTestId("artifact-delete").click();
      await page.getByTestId("artifact-delete-confirm").click();
      await expect(page.locator('[data-testid^="artifact-item-"]')).toHaveCount(0, { timeout: 15000 });
    });
    await step("Open Artifacts from the left sidebar → Files tab shows", async () => {
      await page.getByTestId("sidebar-artifacts-link").click();
      await expect(page.getByTestId("artifacts-panel")).toBeVisible({ timeout: 15000 });
      await expect(page.getByTestId("files-tab-view")).toBeVisible();
    });
  });

  test("upload a file, ask about it, and get the right answer", async ({ page, step }) => {
    await step("Say hi so the thread exists and uploads are enabled", async () => {
      await send(page, "Reply with exactly: ready");
      await waitForReply(page);
    });
    const cases = [
      {
        file: "fixtures/file-qa/secret.pdf",
        name: "secret.pdf",
        ask: "What is the secret fruit named in the attached PDF? Reply with just that one word.",
        secret: "BLUEBERRY",
        label: "PDF",
      },
      {
        file: "fixtures/file-qa/secret.docx",
        name: "secret.docx",
        ask: "What is the secret city named in the attached Word document? Reply with just that one word.",
        secret: "LISBON",
        label: "Word",
      },
      {
        file: "fixtures/file-qa/secret.png",
        name: "secret.png",
        ask: "What is the secret animal written in the attached image? Reply with just that one word.",
        secret: "GIRAFFE",
        label: "image",
      },
    ] as const;
    for (const c of cases) {
      await step(`Attach the ${c.label} file`, async () => {
        await page.locator('input[type="file"]').first().setInputFiles(c.file);
        // Images render a thumbnail (name only in the img alt); documents
        // render the filename as text. PDFs additionally render a
        // first-page thumbnail in the tray.
        const chip =
          c.label === "image"
            ? page.locator(`img[alt="${c.name}"]`).first()
            : page.getByText(c.name).first();
        await expect(chip).toBeVisible({ timeout: 30000 });
        if (c.label === "PDF") {
          const thumb = page.locator(`img[alt="${c.name}"]`).first();
          await expect(
            thumb,
            "PDF first-page thumbnail should appear in the tray",
          ).toBeVisible({ timeout: 30000 });
          // A broken <img> still occupies its CSS box: require decoded pixels.
          const width = await thumb.evaluate((e) =>
            e instanceof HTMLImageElement ? e.naturalWidth : 0,
          );
          expect(width, "PDF thumbnail should decode real pixels").toBeGreaterThan(40);
          // A blank render also decodes: require actual document content.
          // Small text is mostly light-grey anti-aliasing, so count
          // non-white pixels (a correct first-page render measures ~2%).
          const nonwhiteFraction = await thumb.evaluate((e) => {
            if (!(e instanceof HTMLImageElement)) return 0;
            const c = document.createElement("canvas");
            c.width = e.naturalWidth;
            c.height = e.naturalHeight;
            const ctx = c.getContext("2d");
            if (!ctx) return 0;
            ctx.drawImage(e, 0, 0);
            const px = ctx.getImageData(0, 0, c.width, c.height).data;
            let nonwhite = 0;
            for (let i = 0; i < px.length; i += 4) {
              if (px[i] < 245 || px[i + 1] < 245 || px[i + 2] < 245) nonwhite++;
            }
            return nonwhite / (px.length / 4);
          });
          expect(
            nonwhiteFraction,
            "PDF thumbnail should show document text, not a blank page",
          ).toBeGreaterThan(0.005);
        }
      });
      await step(`Ask about the ${c.label} → the answer names ${c.secret}`, async () => {
        const reply = await ask(page, c.ask);
        expect(reply).toContain(c.secret);
      });
    }
  });

  test("pasting long text lands inline in the composer, not as an attachment", async ({
    page,
    step,
  }) => {
    const marker = "PASTE_MARKER_ALPHA_7391";
    const longText = `${marker} ` + "Lorem ipsum dolor sit amet. ".repeat(120);
    await step("Paste a long passage via the real clipboard", async () => {
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
      await page.evaluate((t) => navigator.clipboard.writeText(t), longText);
      await composer(page).click();
      await page.keyboard.press("ControlOrMeta+V");
    });
    await step("The full text lands inline and no attachment tray appears", async () => {
      const box = composer(page);
      await expect(box).toContainText(marker, { timeout: 15000 });
      const editorText = (await box.innerText()).replace(/\s+/g, " ").trim();
      expect(editorText.length).toBeGreaterThan(2000);
      await expect(page.getByRole("list", { name: "Attached files" })).toHaveCount(0);
    });
  });

  test("streaming thinking window and inline tool call descriptions", async ({
    page,
    step,
  }) => {
    await step("Prompt the agent with thinking and tool calls → immediate streaming & unboxed Thinking", async () => {
      await send(
        page,
        "First write a <thinking> block with 4 lines explaining your plan, then run bash `echo 'INLINE_STREAM_OK'`, write '/tmp/e2e-inline-edit.txt' with 'line 1', edit '/tmp/e2e-inline-edit.txt' to replace 'line 1' with 'line 2', and finally reply 'Done'.",
      );
      await expect
        .soft(
          page.locator('[data-testid="work-summary"][data-state="running"]').first(),
          "Streaming timeline: the live card is open while the agent works",
        )
        .toBeVisible({ timeout: 60000 });
      await expect
        .soft(page.getByTestId("worklog-timeline").first(), "steps stream onto the timeline rail")
        .toBeVisible({ timeout: 60000 });
      await expect
        .soft(page.getByTestId("work-summary-headline").first(), "the header narrates the step in progress")
        .not.toBeEmpty();
      if (await page.locator('[data-testid="work-summary"][data-state="running"]').count()) {
        await expect
          .soft(
            page
              .locator('[data-message-role="assistant"]')
              .last()
              .locator('[data-testid="message-content"]:not([data-testid="work-summary"] [data-testid="message-content"])'),
            "while the turn runs, nothing it writes appears outside the card",
          )
          .toHaveCount(0);
      }
      const streamingUi = page
        .getByTestId("streaming-thinking-indicator")
        .or(page.getByTestId("reasoning-part"))
        .or(page.getByText(/^Working…/));
      await expect
        .soft(streamingUi.first(), "streaming thinking or working indicator appears immediately")
        .toBeVisible({ timeout: 30000 });
    });

    await step("While the answer grows the chat follows it to the bottom, and stays put once you scroll up", async () => {
      const box = page.getByTestId("chat-messages-container");
      const gap = () =>
        box.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
      await expect
        .soft(async () => expect(await gap()).toBeLessThan(40), "list follows new content")
        .toPass({ timeout: 20000 });
      const lastMsg = page.locator("[data-message-id]").last();
      const lastBox = await lastMsg.boundingBox();
      const composerTop = (await composer(page).boundingBox())?.y;
      if (lastBox && composerTop) {
        expect.soft(lastBox.y + lastBox.height, "newest text is not hidden behind the composer").toBeLessThanOrEqual(composerTop + 2);
      }
      await box.hover();
      await page.mouse.wheel(0, -600);
      await page.waitForTimeout(1500);
      const top = await box.evaluate((el) => el.scrollTop);
      await page.waitForTimeout(2500);
      const later = await box.evaluate((el) => el.scrollTop);
      expect.soft(Math.abs(later - top), "scrolling up stops the auto-follow").toBeLessThan(40);
    });

    await step("Once complete, Thinking auto-minimizes to plain unboxed text with no left border line", async () => {
      await waitForReply(page, { timeoutMs: 240000 });
      const dock = page.getByTestId("work-status-dock");
      await expect.soft(dock, "Worked summary is docked above the composer").toBeVisible();
      await expect.soft(dock).toContainText(/^Worked/);
      const dockBox = await dock.boundingBox();
      const composerBox = await composer(page).boundingBox();
      if (dockBox && composerBox) {
        expect.soft(dockBox.y, "dock sits above the composer, not at the top of the chat").toBeLessThan(composerBox.y);
        expect.soft(composerBox.y - dockBox.y, "dock is right next to the composer").toBeLessThan(200);
      }
      await page.getByTestId("work-status-dock-close").click();
      await expect.soft(dock, "Close dismisses the dock at once").toBeHidden({ timeout: 5000 });
      const summary = page.getByTestId("work-summary").first();
      await expect(summary, "finished work folds into one summary row").toBeVisible();
      await expect.soft(summary).toContainText(/Thought/);
      await expect
        .soft(page.getByTestId("work-summary").filter({ hasText: /ran \d+ command/i }).first(), "tool calls fold into 'Ran N commands'")
        .toBeVisible();
      const summaryToggle = summary.locator("> button").first();
      await expect.soft(summaryToggle).toHaveAttribute("aria-expanded", "false");
      await expect.soft(page.getByTestId("reasoning-part"), "details stay hidden until the row is clicked").toHaveCount(0);
      await summaryToggle.click();
      await expect.soft(summaryToggle, "folded row opens on click").toHaveAttribute("aria-expanded", "true");
      await summaryToggle.click();
      await expect.soft(summaryToggle, "and folds again").toHaveAttribute("aria-expanded", "false");
      await expect.soft(page.getByTestId("reasoning-part"), "folded body unmounts after the close animation").toHaveCount(0, { timeout: 3000 });
      await summaryToggle.click();
      const reasoning = page.getByTestId("reasoning-part").first();
      await expect.soft(reasoning, "reasoning block is rendered on top").toBeVisible();
      if (await reasoning.isVisible().catch(() => false)) {
        const toggle = reasoning.getByTestId("message-reasoning-toggle");
        await expect.soft(toggle, "finished thinking reads as Thought").toHaveText(/^Thought/);
        await expect
          .soft(reasoning.getByTestId("reasoning-preview"), "a folded thought previews its first sentence")
          .toBeVisible();
        await expect.soft(toggle).toHaveAttribute("aria-expanded", "false");
        // Verify unboxed: no border or background box on the Thinking toggle
        const borderWidth = await toggle.evaluate(
          (el) => window.getComputedStyle(el).borderTopWidth,
        );
        expect.soft(borderWidth, "Thinking label should not have a border box").toBe("0px");
        // Click Thinking to expand -> light text inside bounded window height, no left border line
        await toggle.click();
        const scrollBox = reasoning.getByTestId("message-reasoning-scroll");
        await expect.soft(scrollBox).toBeVisible();
        await page.waitForTimeout(600);
        const styles = await scrollBox.evaluate((el) => {
          const cs = window.getComputedStyle(el);
          return {
            borderLeftWidth: cs.borderLeftWidth,
            maxHeight: cs.maxHeight,
          };
        });
        expect.soft(styles.borderLeftWidth, "Thinking body must not have a left border line").toBe("0px");
        expect.soft(styles.maxHeight, "Thinking body must have bounded max-height").not.toBe("none");
        // Collapse it again
        await toggle.click();
      }
    });

    await step("Streaming timeline folds to one line with its duration; the files-changed card opens the diff", async () => {
      const fold = page.getByTestId("work-summary").last();
      await expect.soft(fold, "the run settles").toHaveAttribute("data-state", "settled");
      await expect.soft(fold.getByTestId("work-summary-elapsed"), "the folded line says how long it worked").toBeVisible();
      await expect
        .soft(
          page.locator('[data-message-role="assistant"]').last().getByTestId("work-summary"),
          "all of a turn's thinking and tool calls live in one card",
        )
        .toHaveCount(1);
      // The step strip stays on the folded card as the turn's fingerprint;
      // a segment opens the card at that step.
      const segments = fold.getByTestId("step-strip-segment");
      expect.soft(await segments.count(), "one strip segment per step").toBeGreaterThan(1);
      await expect.soft(fold.locator('[data-testid="step-strip-segment"][data-kind="command"]').first(), "commands are their own colour").toBeVisible();
      await segments.last().click();
      await expect.soft(fold.locator("> button").first(), "a segment opens the card").toHaveAttribute("aria-expanded", "true");
      await expect.soft(fold.getByTestId("tool-call-result").first(), "steps read as a sentence with what came back").toBeVisible();
      const updates = fold.getByTestId("worklog-note");
      if (await updates.count()) {
        await expect.soft(updates.first(), "the agent's mid-run updates read as a labelled bubble").toContainText(/Update/);
      }
      await page.waitForTimeout(1200);
      await fold.locator("> button").first().click();
      const changes = page.getByTestId("turn-changes-card").last();
      await expect.soft(changes, "files changed card follows the turn").toBeVisible();
      await expect.soft(changes).toContainText(/e2e-inline-edit\.txt/);
      const file = changes.getByTestId("turn-change-file").first();
      await file.locator("> button").click();
      await expect.soft(file.locator("> button"), "file row opens").toHaveAttribute("aria-expanded", "true");
      await expect.soft(file, "the diff shows the edit").toContainText(/line 2/, { timeout: 5000 });
      await page.waitForTimeout(800);
      await file.locator("> button").click();
    });

    await step("Tool calls show description only until clicked, then expand bash and file edit inline", async () => {
      // Finished runs are folded; open every fold to reach the tool rows.
      const folds = page.locator('[data-testid="work-summary"] > button[aria-expanded="false"]');
      while ((await folds.count()) > 0) await folds.first().click();
      const toggles = page.getByTestId("tool-call-toggle");
      const count = await toggles.count();
      expect.soft(count, "at least one inline tool call description toggle is visible").toBeGreaterThan(0);
      await expect.soft(page.getByTestId("tool-call-details")).toHaveCount(0);

      for (let i = 0; i < count; i++) {
        const t = toggles.nth(i);
        await expect.soft(t, "tool call is collapsed to description by default").toHaveAttribute("aria-expanded", "false");
        await t.click();
        await expect.soft(t).toHaveAttribute("aria-expanded", "true");
        await page.waitForTimeout(400);
      }
      const allDetails = page.getByTestId("tool-call-details");
      await expect.soft(allDetails.first(), "clicking tool call description expands details inline").toBeVisible();
      await allDetails.last().scrollIntoViewIfNeeded();
      await page.waitForTimeout(800);
      const combinedText = (await allDetails.allInnerTexts()).join("\n");
      expect.soft(combinedText).toMatch(/INLINE_STREAM_OK|echo/i);
      expect.soft(combinedText).toMatch(/e2e-inline-edit\.txt|line 2/i);
    });

    await step("Tools filter shows only what is ticked", async () => {
      const menuItem = (name: string) => page.getByRole("menuitemcheckbox", { name: new RegExp(name) });
      const open = async () => {
        await page.getByTestId("tool-filter-trigger").click();
      };
      await open();
      await menuItem("Web").click();
      // The menu is still open: the chat must already have changed behind it.
      await expect.soft(page.getByTestId("tool-call-toggle"), "filter applies while the menu is still open").toHaveCount(0, { timeout: 3000 });
      const scroller = page.getByTestId("chat-messages-container");
      await scroller.evaluate((el) => { el.scrollTop = 0; });
      await page.mouse.move(400, 300);
      await page.mouse.wheel(0, 300);
      await page.keyboard.press("Escape");
      await open();
      await menuItem("Web").click();
      await menuItem("Terminal").click();
      await page.keyboard.press("Escape");
      await expect.soft(page.getByTestId("work-summary").filter({ hasText: /ran \d+ command/i }).first(), "ticking Terminal brings its calls back").toBeVisible();
      await open();
      await page.getByRole("menuitem", { name: /Show everything/ }).click();
      await expect.soft(page.getByTestId("work-summary").first()).toBeVisible();
    });

    await step("Reload the page → the thinking is still a collapsed light block, not dark answer text", async () => {
      await page.reload();
      await expect(page.getByTestId("chat-messages-container")).toBeVisible({ timeout: 30000 });
      const reloadedSummary = page.getByTestId("work-summary").first();
      await expect.soft(reloadedSummary, "reloaded chat shows the same folded summary").toBeVisible({ timeout: 30000 });
      await reloadedSummary.locator("> button").first().click();
      const reasoning = page.getByTestId("reasoning-part").first();
      await expect.soft(reasoning, "reloaded chat still shows the Thinking block").toBeVisible({ timeout: 30000 });
      await expect.soft(reasoning.getByTestId("message-reasoning-toggle")).toHaveAttribute("aria-expanded", "false");
      const main = await page.locator("main").innerText();
      expect.soft(main, "no raw reasoning sentinel leaks into the page").not.toContain("\u2063");
      await expect.soft(page.getByTestId("work-status-dock"), "a reopened chat does not flash the Worked bar").toHaveCount(0);
    });
  });
  test("file paths in chat open in the viewer for any kind of file", async ({ page, amiro, step }) => {
    const P = "/home/shrivallabha_somayaji_tyson_com/Projects/Personal";
    const T = "/home/shrivallabha_somayaji_tyson_com/Projects/3368-haystack-paap";
    // Real files that already exist on this machine, one per kind.
    const samples: { name: string; from: string; testId: string; expect?: RegExp }[] = [
      { name: "resume.pdf", from: `${P}/local/Shrivallabha Somayaji (3).pdf`, testId: "file-preview-pdf" },
      { name: "spec.pdf", from: "/usr/share/doc/shared-mime-info/shared-mime-info-spec.pdf", testId: "file-preview-pdf" },
      { name: "guide.docx", from: `${T}/competitoriq/docs/Working-on-CompetitorIQ-with-Claude.docx`, testId: "file-preview-docx" },
      { name: "model.xlsx", from: "/home/shrivallabha_somayaji_tyson_com/.codex/.tmp/plugins/plugins/public-equity-investing/skills/dcf-model-builder/assets/templates/banker_formula_workbook_template.xlsx", testId: "file-preview-xlsx" },
      { name: "checklist.docx", from: `${P}/app.vegaai.dev.v2/tests/fixtures/knowledge-bases/onboarding-checklist.docx`, testId: "file-preview-docx" },
      { name: "talk.pptx", from: `${T}/deployment-web-app/docs-service/public/haystack-tech-talk.pptx`, testId: "file-preview-pptx" },
      { name: "limits.xlsx", from: `${P}/app.vegaai.dev.v2/tests/fixtures/knowledge-bases/refund-limits.xlsx`, testId: "file-preview-xlsx" },
      { name: "oui.csv", from: "/usr/share/ieee-data/mam.csv", testId: "file-preview-csv" },
      { name: "graph.jpg", from: "/usr/share/doc/sysstat/images/cpugraph.jpg", testId: "file-preview-image" },
      { name: "demo.mp4", from: `${P}/OpenDots/docs/demos/computer-chat.mp4`, testId: "file-preview-video" },
      { name: "sample.mp3", from: `${P}/app.vegaai.dev.v2/core/internal/llmtests/scenarios/media/sample.mp3`, testId: "file-preview-audio" },
      { name: "bundle.zip", from: "/usr/local/go/src/archive/zip/testdata/utf8-7zip.zip", testId: "" },
    ];
    await step(`Copy ${samples.length} real files from this machine into the workspace`, async () => {
      for (const f of samples) {
        const content = fs.readFileSync(f.from).toString("base64");
        const res = await amiro.api("/api/workspace/write", {
          method: "POST",
          body: JSON.stringify({ path: `e2e-viewer/${f.name}`, content, encoding: "base64" }),
        });
        expect(res.status, `uploaded ${f.name}`).toBe(200);
      }
    });

    await step("Ask the agent to name the files → every path becomes a clickable chip", async () => {
      await newChat(page);
      await selectModel(page);
      await send(
        page,
        `Reply with only these file paths, each in its own inline code span, nothing else: ${samples.map((f) => "`e2e-viewer/" + f.name + "`").join(" ")}`,
      );
      await waitForReply(page, { timeoutMs: 180000 });
      await expect(page.getByTestId("chat-file-path")).toHaveCount(samples.length, { timeout: 15000 });
    });

    const open = async (name: string) => {
      const tab = page.getByTestId("workspace-file-tab");
      if (await tab.isVisible().catch(() => false)) await page.getByTestId("workspace-file-tab-back").click();
      await page.locator(`[data-testid="chat-file-path"][data-path="e2e-viewer/${name}"]`).click();
      await expect(tab, "the Files tab opens with the workspace viewer").toBeVisible();
      await page.waitForTimeout(1200);
    };

    await step("Your own PDF opens exactly as the original pages", async () => {
      await open("resume.pdf");
      const pages = page.getByTestId("file-preview-pdf-page");
      await expect(pages.first()).toBeVisible({ timeout: 30000 });
      await page.waitForTimeout(3500);
    });
    await step("PDF renders in the page viewer", async () => {
      await open("spec.pdf");
      const pages = page.getByTestId("file-preview-pdf-page");
      await expect(pages.first(), "first PDF page is drawn").toBeVisible({ timeout: 30000 });
      await expect.poll(() => pages.count(), { timeout: 30000 }).toBeGreaterThan(1);
      // A drawn page has ink on it, not a blank white canvas.
      const inked = await pages.first().evaluate((c: HTMLCanvasElement) => {
        const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
        let dark = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] < 128) dark++;
        return dark;
      });
      expect(inked, "page has visible text").toBeGreaterThan(200);
      await page.waitForTimeout(1500);
    });
    await step("Word document renders as text", async () => {
      await open("checklist.docx");
      const doc = page.getByTestId("file-preview-docx");
      await expect(doc).toBeVisible({ timeout: 20000 });
      await expect.poll(async () => (await doc.innerText()).trim().length, { timeout: 20000 }).toBeGreaterThan(20);
    });
    await step("Word guide keeps its page, headings and colours", async () => {
      await open("guide.docx");
      const doc = page.getByTestId("file-preview-docx");
      await expect(doc.locator("section.docx").first(), "a real page sheet is drawn").toBeVisible({ timeout: 20000 });
      await expect(doc).toContainText(/Working on CompetitorIQ/i);
      await page.waitForTimeout(1500);
    });
    await step("Excel model keeps its styling and sheet tabs", async () => {
      await open("model.xlsx");
      const sheet = page.getByTestId("file-preview-xlsx");
      await expect(sheet, "sheet tabs are present").toContainText(/Executive Summary/i, { timeout: 20000 });
      await expect(sheet.locator("canvas").first(), "the styled grid is drawn").toBeVisible();
      const ink = await sheet.locator("canvas").first().evaluate((c: HTMLCanvasElement) => {
        const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
        let coloured = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 0 && !(d[i] > 245 && d[i + 1] > 245 && d[i + 2] > 245)) coloured++;
        return coloured;
      });
      expect(ink, "the grid has real cell styling, not a blank canvas").toBeGreaterThan(2000);
      await page.waitForTimeout(1500);
    });
    await step("PowerPoint renders slide by slide", async () => {
      await open("talk.pptx");
      const deck = page.getByTestId("file-preview-pptx");
      await expect(deck).toBeVisible({ timeout: 20000 });
      await expect(deck, "slide text is drawn").toContainText(/fastest way to/i, { timeout: 20000 });
      const box = await deck.boundingBox();
      expect(box?.height ?? 0, "slides take real page height").toBeGreaterThan(300);
    });
    await step("Excel renders as a grid with sheet tabs", async () => {
      await open("limits.xlsx");
      const sheet = page.getByTestId("file-preview-xlsx");
      await expect(sheet).toBeVisible({ timeout: 20000 });
      await expect(sheet, "sheet tabs are drawn").toContainText(/Refund Limits/i, { timeout: 20000 });
    });
    await step("CSV renders as a grid", async () => {
      await open("oui.csv");
      const csv = page.getByTestId("file-preview-csv");
      await expect(csv).toBeVisible({ timeout: 20000 });
      await expect.poll(() => csv.locator("tr").count(), { timeout: 20000 }).toBeGreaterThan(10);
      await expect(csv, "real cell text shows").toContainText(/[0-9A-F]{6}/);
    });
    await step("Image renders", async () => {
      await open("graph.jpg");
      const img = page.getByTestId("file-preview-image");
      await expect(img).toBeVisible({ timeout: 20000 });
      await expect.poll(() => img.evaluate((e: HTMLImageElement) => e.naturalWidth)).toBeGreaterThan(10);
    });
    await step("MP4 video plays", async () => {
      await open("demo.mp4");
      const video = page.getByTestId("file-preview-video");
      await expect(video).toBeVisible({ timeout: 20000 });
      await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 20000 }).toBeGreaterThan(1);
      await video.evaluate((v: HTMLVideoElement) => { v.muted = true; return v.play(); });
      await page.waitForTimeout(3000);
      expect(await video.evaluate((v: HTMLVideoElement) => v.currentTime), "video advanced").toBeGreaterThan(0.5);
    });
    await step("MP3 audio has a player", async () => {
      await open("sample.mp3");
      const audio = page.getByTestId("file-preview-audio");
      await expect(audio).toBeVisible({ timeout: 20000 });
      await expect.poll(() => audio.evaluate((a: HTMLAudioElement) => a.readyState), { timeout: 20000 }).toBeGreaterThan(0);
    });
    await step("A type with no reader says so and offers a download", async () => {
      await open("bundle.zip");
      await expect(page.getByTestId("workspace-file-tab")).toContainText(/No preview/i);
      await expect(page.getByTestId("workspace-file-tab").getByRole("button", { name: /Download/ }).first()).toBeVisible();
    });
    await step("Opening the same files from the Artifacts list looks identical", async () => {
      // Register the files as artifacts, then open each from the list instead of from chat.
      const kinds: [string, string, string][] = [
        ["guide.docx", `${T}/competitoriq/docs/Working-on-CompetitorIQ-with-Claude.docx`, "file-preview-docx"],
        ["talk.pptx", `${T}/deployment-web-app/docs-service/public/haystack-tech-talk.pptx`, "file-preview-pptx"],
        ["limits.xlsx", `${P}/app.vegaai.dev.v2/tests/fixtures/knowledge-bases/refund-limits.xlsx`, "file-preview-xlsx"],
        ["resume.pdf", `${P}/local/Shrivallabha Somayaji (3).pdf`, "file-preview-pdf"],
      ];
      for (const [filename, from] of kinds) {
        const res = await amiro.api("/api/artifacts", {
          method: "POST",
          body: JSON.stringify({ title: filename, filename, contentBase64: fs.readFileSync(from).toString("base64") }),
        });
        expect(res.status, `artifact ${filename} created`).toBeLessThan(300);
      }
      const back = page.getByTestId("workspace-file-tab-back");
      if (await back.isVisible().catch(() => false)) await back.click();
      await expect(page.getByTestId("artifacts-panel")).toBeVisible();
      await page.getByTestId("artifacts-refresh").click();
      await expect(page.locator('[data-testid^="artifact-item-"]').filter({ hasText: "guide.docx" }).first()).toBeVisible({ timeout: 15000 });
      for (const [filename, , testId] of kinds) {
        await page.locator('[data-testid^="artifact-item-"]').filter({ hasText: filename }).first().click();
        await expect(page.getByTestId("artifact-viewer").getByTestId(testId), `${filename} from Artifacts`).toBeVisible({ timeout: 30000 });
        await page.waitForTimeout(2500);
      }
    });
    await step("Back from a chat-opened file returns to the artifact files list", async () => {
      await open("graph.jpg");
      await page.getByTestId("workspace-file-tab-back").click();
      await expect(page.getByTestId("artifacts-panel")).toBeVisible();
      // Back lists every file the chat names, not only saved artifacts.
      await expect(page.getByTestId("chat-files-heading")).toBeVisible();
      await expect(page.getByTestId("chat-file-item"), "all 12 files from the chat are listed").toHaveCount(12);
      await expect(page.locator('[data-testid="chat-file-item"][data-path="e2e-viewer/demo.mp4"]')).toBeVisible();
      // And each one opens from that list.
      await page.locator('[data-testid="chat-file-item"][data-path="e2e-viewer/sample.mp3"]').click();
      await expect(page.getByTestId("file-preview-audio")).toBeVisible({ timeout: 20000 });
      await page.getByTestId("workspace-file-tab-back").click();
      await expect(page.getByTestId("chat-file-item")).toHaveCount(12);
    });
  });
});
