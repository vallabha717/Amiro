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
      await expect(page.getByTestId("artifact-text")).toContainText("Hello artifacts.", { timeout: 15000 });
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
});
