/**
 * Journey 4 — chatting with the configured model: rich rendering (tables,
 * code, mermaid, inline visuals), tool calling (web search), swarm
 * delegation, skills, follow-up queue, message actions and thread management.
 *
 * Model output varies, so render checks are soft (`expect.soft`): the test is
 * marked failed but the journey keeps going and the video keeps recording.
 */
import { ask, assistantMessages, composer, newChat, selectModel, send, toolCallsShown, waitForReply } from "../support/chat";
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
    await step("Open the Tools menu in the chat header", async () => {
      const tools = page.getByRole("button", { name: "Tools" });
      if (await tools.isVisible()) {
        await tools.click();
        await page.waitForTimeout(800);
        await page.keyboard.press("Escape");
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

  test("skills (/) and tools (@) palettes in the composer", async ({ page, step, note }) => {
    await step("Type / in an empty composer → skill palette opens", async () => {
      await composer(page).click();
      await page.keyboard.type("/weath", { delay: 40 });
      await expect(page.getByTestId("skill-palette")).toBeVisible();
    });
    await step("Pick the Weather skill → chip in the composer", async () => {
      const palette = page.getByTestId("skill-palette");
      await expect(palette.getByTestId("skill-palette-loading")).toBeHidden({ timeout: 15000 });
      const items = palette.locator('[data-testid^="skill-palette-item-"]');
      if (!(await items.count())) {
        note(`"/" skill palette finds nothing for "weath": ${(await palette.innerText()).replace(/\s+/g, " ").slice(0, 160)}`, "bug");
      }
      expect.soft(await items.count(), "the / palette should list the built-in weather skill").toBeGreaterThan(0);
      if (await items.count()) {
        await items.first().click();
        await expect.soft(page.locator('[data-testid^="skill-chip-"]').first()).toBeVisible();
      } else {
        await page.keyboard.press("Escape");
        await page.keyboard.press("Control+A");
        await page.keyboard.press("Backspace");
      }
    });
    await step("Ask with the skill attached", async () => {
      await page.keyboard.type(" what's the weather in Paris right now?", { delay: 10 });
      const before = await assistantMessages(page).count();
      await page.keyboard.press("Enter");
      const reply = await waitForReply(page, { before });
      expect.soft(reply).toMatch(/Paris|°|weather/i);
    });
    await step("Type @ → tools/MCP palette lists built-in tools", async () => {
      await composer(page).click();
      await page.keyboard.type("@", { delay: 40 });
      const palette = page.getByRole("dialog").filter({ has: page.getByRole("textbox", { name: "Search..." }) });
      await expect.soft(palette).toBeVisible();
      await page.waitForTimeout(800);
      await page.keyboard.press("Escape");
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
    await step("Hover the reply: copy, read-aloud and edit actions exist", async () => {
      await assistantMessages(page).last().hover();
      await expect.soft(page.getByTestId("message-read-aloud-button").last()).toBeVisible();
    });
    await step("Edit the first user message and resend", async () => {
      const userMsg = page.getByTestId("message-content").first();
      await userMsg.hover();
      const edit = page.locator('[data-testid^="message-edit-button"]').first();
      if (await edit.isVisible().catch(() => false)) {
        await edit.click();
        const editor = page.getByTestId("message-editor-text");
        if (await editor.isVisible().catch(() => false)) {
          await editor.fill("Write a 2-sentence story about a lighthouse keeper.");
          await page.getByTestId("message-editor-send-button").click();
          await waitForReply(page, { before: 0 });
        }
      }
    });
    await step("The conversation appears in Recent Chats with a generated title", async () => {
      const thread = page.locator('a[href^="/?thread="]').first();
      await expect.soft(thread, "a sidebar link to the conversation").toBeVisible({ timeout: 30000 });
    });
    await step("Start a new chat with the keyboard shortcut", async () => {
      await page.keyboard.press("Control+Shift+O");
      await expect(page).toHaveURL(/\/$|\/\?$/);
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
        await expect.soft(toggle).toHaveText("Thinking");
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
    });
  });
});
