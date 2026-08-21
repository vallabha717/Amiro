import { test, expect } from "../../support/fixtures";
import { ChatPage, SkillPalette } from "../../pages";
import { plantSkill } from "../../support/plant-skill";

test.describe("skills palette", () => {
  test("empty state: opens palette showing empty indicator when no skills exist", async ({
    amiro,
    page,
  }) => {
    // No skills planted on this backend
    const userToken = amiro.accounts?.user?.token;
    await page.addInitScript((token) => {
      try {
        window.localStorage?.setItem("amiro.session-token", token);
      } catch {}
    }, userToken);

    const chat = new ChatPage(page);
    await chat.goto();
    const palette = new SkillPalette(page);

    const editor = page.locator(".ProseMirror").first();
    await expect(editor).toBeVisible({ timeout: 15000 });
    await editor.click();
    await page.keyboard.type("/");

    await expect(palette.container).toBeVisible({ timeout: 15000 });
    await expect(palette.emptyState).toBeVisible({ timeout: 15000 });
  });

  test("error state: renders error indicator when /api/skills fails (e.g. invalid projectDirectory)", async ({
    amiro,
    page,
  }) => {
    const userToken = amiro.accounts?.user?.token;
    await page.addInitScript(
      ({ token }) => {
        try {
          window.localStorage?.setItem("amiro.session-token", token);
          const stored = window.localStorage?.getItem("mc-app-store-v2.0.1");
          const parsed = stored ? JSON.parse(stored) : { state: {} };
          parsed.state = {
            ...parsed.state,
            projectDirectory: "/path/that/does/not/exist/for/skills/error/test",
          };
          window.localStorage?.setItem(
            "mc-app-store-v2.0.1",
            JSON.stringify(parsed),
          );
        } catch {}
      },
      { token: userToken },
    );

    const chat = new ChatPage(page);
    await chat.goto();
    const palette = new SkillPalette(page);

    const editor = page.locator(".ProseMirror").first();
    await expect(editor).toBeVisible({ timeout: 15000 });
    await editor.click();
    await page.keyboard.type("/");

    await expect(palette.container).toBeVisible({ timeout: 15000 });
    await expect(palette.errorState).toBeVisible({ timeout: 15000 });
    await expect(palette.emptyState).toBeHidden();
  });

  test("trigger rule: '/' on empty composer opens palette, mid-sentence does not", async ({
    amiro,
    page,
  }) => {
    plantSkill(amiro, {
      name: "trigger-test-skill",
      description: "Tests trigger boundary conditions",
      scope: "user",
    });

    const userToken = amiro.accounts?.user?.token;
    await page.addInitScript((token) => {
      try {
        window.localStorage?.setItem("amiro.session-token", token);
      } catch {}
    }, userToken);

    const chat = new ChatPage(page);
    await chat.goto();
    const palette = new SkillPalette(page);

    const editor = page.locator(".ProseMirror").first();
    await expect(editor).toBeVisible({ timeout: 15000 });

    // Mid-sentence typing should NOT open palette
    await editor.click();
    await page.keyboard.type("Hello /trigger-test");
    await expect(palette.container).toBeHidden();
    await expect(editor).toHaveText("Hello /trigger-test");

    // Clear and type '/' at start of empty composer -> opens palette
    await editor.press("ControlOrMeta+a");
    await editor.press("Backspace");
    await expect(editor).toHaveText("");
    await page.keyboard.type("/");
    await expect(palette.container).toBeVisible({ timeout: 15000 });
    await expect(palette.item("trigger-test-skill")).toBeVisible({ timeout: 15000 });
  });

  test("four-directory plant shows exactly one row with .agents badge", async ({
    amiro,
    page,
  }) => {
    // Plant identical skill name in .agents, .amiro, .claude, and .codex
    plantSkill(amiro, {
      name: "four-root-skill",
      description: "Agents version",
      source: ".agents",
      scope: "user",
    });
    plantSkill(amiro, {
      name: "four-root-skill",
      description: "Amiro version",
      source: ".amiro",
      scope: "user",
    });
    plantSkill(amiro, {
      name: "four-root-skill",
      description: "Claude version",
      source: ".claude",
      scope: "user",
    });
    plantSkill(amiro, {
      name: "four-root-skill",
      description: "Codex version",
      source: ".codex",
      scope: "user",
    });

    const userToken = amiro.accounts?.user?.token;
    await page.addInitScript((token) => {
      try {
        window.localStorage?.setItem("amiro.session-token", token);
      } catch {}
    }, userToken);

    const chat = new ChatPage(page);
    await chat.goto();
    const palette = new SkillPalette(page);

    const editor = page.locator(".ProseMirror").first();
    await expect(editor).toBeVisible({ timeout: 15000 });
    await editor.click();
    await page.keyboard.type("/");

    await expect(palette.container).toBeVisible({ timeout: 15000 });
    const row = palette.item("four-root-skill");
    await expect(row).toBeVisible({ timeout: 15000 });
    await expect(row).toHaveCount(1);

    // Assert the badge inside this row is .agents
    const badge = row.locator('[data-testid="skill-palette-source-.agents"]');
    await expect(badge).toBeVisible({ timeout: 15000 });
    await expect(badge).toHaveText(".agents");
  });

  test("project and user skills grouped and badged with prefix filtering", async ({
    amiro,
    page,
  }) => {
    plantSkill(amiro, {
      name: "proj-alpha",
      description: "Project alpha skill",
      scope: "project",
      source: ".agents",
    });
    plantSkill(amiro, {
      name: "user-alpha",
      description: "User alpha skill",
      scope: "user",
      source: ".agents",
    });
    plantSkill(amiro, {
      name: "user-beta",
      description: "User beta skill",
      scope: "user",
      source: ".agents",
    });

    const userToken = amiro.accounts?.user?.token;
    await page.addInitScript(
      ({ token, workspace }) => {
        try {
          window.localStorage?.setItem("amiro.session-token", token);
          const stored = window.localStorage?.getItem("mc-app-store-v2.0.1");
          const parsed = stored ? JSON.parse(stored) : { state: {} };
          parsed.state = { ...parsed.state, projectDirectory: workspace };
          window.localStorage?.setItem("mc-app-store-v2.0.1", JSON.stringify(parsed));
        } catch {}
      },
      { token: userToken, workspace: amiro.workspace },
    );

    const chat = new ChatPage(page);
    await chat.goto();
    const palette = new SkillPalette(page);

    const editor = page.locator(".ProseMirror").first();
    await expect(editor).toBeVisible({ timeout: 15000 });
    await editor.click();
    await page.keyboard.type("/");

    await expect(palette.container).toBeVisible({ timeout: 15000 });

    // Assert group headers are present
    await expect(palette.groupProject).toBeVisible({ timeout: 15000 });
    await expect(palette.groupUser).toBeVisible({ timeout: 15000 });

    await expect(palette.item("proj-alpha")).toBeVisible({ timeout: 15000 });
    await expect(palette.item("user-alpha")).toBeVisible({ timeout: 15000 });
    await expect(palette.item("user-beta")).toBeVisible({ timeout: 15000 });

    // Assert project skill precedes user skills in DOM order
    const itemNames = await page
      .locator('[data-testid^="skill-palette-item-"]')
      .evaluateAll((elements) =>
        elements.map((el) =>
          el.getAttribute("data-testid")?.replace("skill-palette-item-", ""),
        ),
      );
    expect(itemNames.indexOf("proj-alpha")).toBeLessThan(
      itemNames.indexOf("user-alpha"),
    );
    expect(itemNames.indexOf("proj-alpha")).toBeLessThan(
      itemNames.indexOf("user-beta"),
    );

    // Prefix filtering: type "user-b"
    await page.keyboard.type("user-b");
    await expect(palette.item("user-beta")).toBeVisible({ timeout: 15000 });
    await expect(palette.item("user-alpha")).toBeHidden();
    await expect(palette.item("proj-alpha")).toBeHidden();
  });

  test("disable-model-invocation: true skills appear in the palette alongside regular skills (Decision D)", async ({
    amiro,
    page,
  }) => {
    plantSkill(amiro, {
      name: "manual-only-skill",
      description: "Manual invocation only skill",
      scope: "user",
      disableModelInvocation: true,
    });
    plantSkill(amiro, {
      name: "regular-skill",
      description: "Standard model invokable skill",
      scope: "user",
    });

    const userToken = amiro.accounts?.user?.token;
    await page.addInitScript((token) => {
      try {
        window.localStorage?.setItem("amiro.session-token", token);
      } catch {}
    }, userToken);

    const chat = new ChatPage(page);
    await chat.goto();
    const palette = new SkillPalette(page);

    const editor = page.locator(".ProseMirror").first();
    await expect(editor).toBeVisible({ timeout: 15000 });
    await editor.click();
    await page.keyboard.type("/");

    await expect(palette.container).toBeVisible({ timeout: 15000 });
    await expect(palette.item("manual-only-skill")).toBeVisible({ timeout: 15000 });
    await expect(palette.item("regular-skill")).toBeVisible({ timeout: 15000 });
  });

  test("keyboard navigation and selection renders chip and deletes composer range", async ({
    amiro,
    page,
  }) => {
    plantSkill(amiro, {
      name: "keyboard-skill",
      description: "Keyboard selectable skill",
      scope: "user",
    });

    const userToken = amiro.accounts?.user?.token;
    await page.addInitScript((token) => {
      try {
        window.localStorage?.setItem("amiro.session-token", token);
      } catch {}
    }, userToken);

    const chat = new ChatPage(page);
    await chat.goto();
    const palette = new SkillPalette(page);

    const editor = page.locator(".ProseMirror").first();
    await expect(editor).toBeVisible({ timeout: 15000 });
    await editor.click();
    await page.keyboard.type("/");

    await expect(palette.container).toBeVisible({ timeout: 15000 });
    await expect(palette.item("keyboard-skill")).toBeVisible({ timeout: 15000 });

    // Press ArrowDown then Enter to select
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");

    // Palette closes, chip is visible, editor is empty
    await expect(palette.container).toBeHidden();
    await expect(palette.chip("keyboard-skill")).toBeVisible({ timeout: 15000 });
    const editorText = await editor.innerText();
    expect(editorText.trim()).toBe("");

    // Chip remove button removes the chip
    await palette.removeChip("keyboard-skill");
    await expect(palette.chip("keyboard-skill")).toBeHidden();
  });

  test("escape closes palette without selecting and preserves already-selected chips (Item 1 bugfix)", async ({
    amiro,
    page,
  }) => {
    plantSkill(amiro, {
      name: "escape-skill-a",
      description: "First escape test skill",
      scope: "user",
    });
    plantSkill(amiro, {
      name: "escape-skill-b",
      description: "Second escape test skill",
      scope: "user",
    });

    const userToken = amiro.accounts?.user?.token;
    await page.addInitScript((token) => {
      try {
        window.localStorage?.setItem("amiro.session-token", token);
      } catch {}
    }, userToken);

    const chat = new ChatPage(page);
    await chat.goto();
    const palette = new SkillPalette(page);

    const editor = page.locator(".ProseMirror").first();
    await expect(editor).toBeVisible({ timeout: 15000 });

    // Step 1: Open palette and select skill A
    await editor.click();
    await page.keyboard.type("/");
    await expect(palette.container).toBeVisible({ timeout: 15000 });
    await palette.selectItem("escape-skill-a");
    await expect(palette.chip("escape-skill-a")).toBeVisible({ timeout: 15000 });

    // Step 2: Open palette again by typing '/'
    await editor.click();
    await page.keyboard.type("/");
    await expect(palette.container).toBeVisible({ timeout: 15000 });

    // Step 3: Press Escape with palette open
    // Palette closes, but escape-skill-a chip MUST still be visible!
    await page.keyboard.press("Escape");
    await expect(palette.container).toBeHidden();
    await expect(palette.chip("escape-skill-a")).toBeVisible({ timeout: 15000 });

    // Step 4: Press Escape with palette closed -> clears mentions (existing behavior)
    await page.keyboard.press("Escape");
    await expect(palette.chip("escape-skill-a")).toBeHidden();
  });

  test("palette names equal API response names for user and project by interception (bi-directional check)", async ({
    amiro,
    page,
  }) => {
    plantSkill(amiro, { name: "skill-one", description: "First", scope: "project" });
    plantSkill(amiro, { name: "skill-two", description: "Second", scope: "user" });
    plantSkill(amiro, { name: "skill-three", description: "Third", scope: "user" });

    const userToken = amiro.accounts?.user?.token;
    await page.addInitScript(
      ({ token, workspace }) => {
        try {
          window.localStorage?.setItem("amiro.session-token", token);
          const stored = window.localStorage?.getItem("mc-app-store-v2.0.1");
          const parsed = stored ? JSON.parse(stored) : { state: {} };
          parsed.state = { ...parsed.state, projectDirectory: workspace };
          window.localStorage?.setItem("mc-app-store-v2.0.1", JSON.stringify(parsed));
        } catch {}
      },
      { token: userToken, workspace: amiro.workspace },
    );

    const chat = new ChatPage(page);
    await chat.goto();
    const palette = new SkillPalette(page);

    // Intercept GET /api/skills response
    const skillsResponsePromise = page.waitForResponse((resp) =>
      resp.url().includes("/api/skills") && resp.status() === 200,
    );

    const editor = page.locator(".ProseMirror").first();
    await expect(editor).toBeVisible({ timeout: 15000 });
    await editor.click();
    await page.keyboard.type("/");

    const skillsResponse = await skillsResponsePromise;
    const json = await skillsResponse.json();

    await expect(palette.container).toBeVisible({ timeout: 15000 });

    // Read all rendered names in DOM order
    const renderedNames = await page
      .locator('[data-testid^="skill-palette-item-"]')
      .evaluateAll((elements) =>
        elements.map((el) =>
          el.getAttribute("data-testid")?.replace("skill-palette-item-", ""),
        ),
      );

    // Expected order: project items first (in backend order), then user items (in backend order)
    const projectApiNames: string[] = json.items
      .filter((it: any) => it.scope === "project")
      .map((it: any) => it.name);
    const userApiNames: string[] = json.items
      .filter((it: any) => it.scope === "user")
      .map((it: any) => it.name);
    const expectedNames = [...projectApiNames, ...userApiNames];

    // Bi-directional assertion: exact match, count, and grouped order
    expect(renderedNames).toEqual(expectedNames);
  });

  test("chat request body includes skill mention and does NOT strip app default toolkit (Trap 2 guard)", async ({
    amiro,
    page,
  }) => {
    plantSkill(amiro, {
      name: "turn-skill",
      description: "Skill to include in chat turn",
      scope: "user",
    });

    const userToken = amiro.accounts?.user?.token;
    await page.addInitScript((token) => {
      try {
        window.localStorage?.setItem("amiro.session-token", token);
      } catch {}
    }, userToken);

    const chat = new ChatPage(page);
    await chat.goto();
    const palette = new SkillPalette(page);

    const editor = page.locator(".ProseMirror").first();
    await expect(editor).toBeVisible({ timeout: 15000 });
    await editor.click();
    await page.keyboard.type("/");

    await expect(palette.container).toBeVisible({ timeout: 15000 });
    await palette.selectItem("turn-skill");
    await expect(palette.chip("turn-skill")).toBeVisible({ timeout: 15000 });

    // Type prompt message
    await editor.click();
    await page.keyboard.type("Please help me using the attached skill");

    // Intercept outgoing chat request
    const chatRequestPromise = page.waitForRequest((req) =>
      req.url().includes("/api/chat") && req.method() === "POST",
    );

    await chat.sendButton.click();

    const chatRequest = await chatRequestPromise;
    const reqBody = chatRequest.postDataJSON();

    // Mentions must contain the skill mention
    expect(reqBody.mentions).toBeDefined();
    const skillMention = reqBody.mentions.find(
      (m: any) => m.type === "skill" && m.name === "turn-skill",
    );
    expect(skillMention).toBeDefined();

    // Trap 2 assertion: allowedAppDefaultToolkit must NOT be stripped to empty array []
    // when only a skill mention is present
    expect(reqBody.allowedAppDefaultToolkit).not.toEqual([]);
  });

  test("@-mention flow still works with skill extension registered and selects an app tool (Criterion 4)", async ({
    amiro,
    page,
  }) => {
    const userToken = amiro.accounts?.user?.token;
    await page.addInitScript(
      ({ token, workspace }) => {
        try {
          window.localStorage?.setItem("amiro.session-token", token);
          const stored = window.localStorage?.getItem("mc-app-store-v2.0.1");
          const parsed = stored ? JSON.parse(stored) : { state: {} };
          parsed.state = { ...parsed.state, projectDirectory: workspace };
          window.localStorage?.setItem(
            "mc-app-store-v2.0.1",
            JSON.stringify(parsed),
          );
        } catch {}
      },
      { token: userToken, workspace: amiro.workspace },
    );

    const chat = new ChatPage(page);
    await chat.goto();

    const editor = page.locator(".ProseMirror").first();
    await expect(editor).toBeVisible({ timeout: 15000 });
    await editor.click();
    await page.keyboard.type("@");

    // Suggestion popover for @-mentions appears
    const suggestionPopover = page.locator(
      '[data-testid="chat-mention-suggestion"]',
    );
    await expect(suggestionPopover).toBeVisible({ timeout: 15000 });

    // Find and click the default tool item ('table')
    const defaultToolItem = page.locator(
      '[data-testid="chat-mention-item-table"]',
    );
    await expect(defaultToolItem).toBeVisible({ timeout: 15000 });
    await defaultToolItem.click();

    // Suggestion popover closes and mention node is rendered in the editor
    await expect(suggestionPopover).toBeHidden();
    await expect(editor).toContainText("table");

    // Type query and send message
    await page.keyboard.type(" Generate a table");

    const chatRequestPromise = page.waitForRequest((req) =>
      req.url().includes("/api/chat") && req.method() === "POST",
    );

    await chat.sendButton.click();

    const chatRequest = await chatRequestPromise;
    const reqBody = chatRequest.postDataJSON();

    // With a non-skill mention (defaultTool) attached, allowedAppDefaultToolkit MUST be stripped to []
    expect(reqBody.allowedAppDefaultToolkit).toEqual([]);
    expect(reqBody.mentions).toBeDefined();
    const toolMention = reqBody.mentions.find(
      (m: any) => m.type === "defaultTool",
    );
    expect(toolMention).toBeDefined();
  });
});
