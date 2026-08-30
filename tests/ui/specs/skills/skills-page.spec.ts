import { test, expect } from "../../support/fixtures";
import { SkillDetailPage, SkillPalette, SkillsPage } from "../../pages";
import { plantSkill } from "../../support/plant-skill";

// Reads the signed-in session token straight out of localStorage and calls
// a same-origin /api route with it -- the same auth the app's own
// apiFetch() sends when isSameOriginBackend() is true (client.ts), which
// is how this UI test harness's backend is reached. Used where an
// assertion must go through the real API rather than the DOM (Phase 5's
// exit criterion 4: "verified through GET /api/skills, not through the DOM").
async function apiGetSkills(page: import("@playwright/test").Page) {
  return page.evaluate(async () => {
    const token = window.localStorage.getItem("amiro.session-token");
    const res = await fetch("/api/skills", {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    return res.json();
  });
}

function signIn(page: import("@playwright/test").Page, token: string) {
  return page.addInitScript((t) => {
    try {
      window.localStorage?.setItem("amiro.session-token", t);
    } catch {}
  }, token);
}

test.describe("skills page", () => {
  test("lists writable and read-only skills in their own sections with source badges", async ({
    amiro,
    page,
  }) => {
    plantSkill(amiro, {
      name: "writable-list-skill",
      description: "A writable skill for the list test",
      scope: "user",
      source: ".agents",
    });
    plantSkill(amiro, {
      name: "readonly-list-skill",
      description: "A read-only skill for the list test",
      scope: "user",
      source: ".claude",
    });

    await signIn(page, amiro.accounts.user.token);
    const skills = new SkillsPage(page);
    await skills.goto();

    const writableCard = skills.skillCardByName("writable-list-skill");
    const readonlyCard = skills.skillCardByName("readonly-list-skill");
    await expect(writableCard).toBeVisible({ timeout: 15000 });
    await expect(readonlyCard).toBeVisible({ timeout: 15000 });

    // The writable card carries no lock icon; the read-only one does.
    await expect(writableCard.locator('[data-testid="skill-card-lock"]')).toHaveCount(0);
    await expect(readonlyCard.locator('[data-testid="skill-card-lock"]')).toHaveCount(1);

    await expect(writableCard.locator('[data-testid="skill-card-source-.agents"]')).toBeVisible();
    await expect(readonlyCard.locator('[data-testid="skill-card-source-.claude"]')).toBeVisible();
  });

  test("create → appears in the list → appears in the '/' palette without a reload", async ({
    signedIn,
  }) => {
    const skillName = "created-from-ui-skill";

    const skills = new SkillsPage(signedIn);
    await skills.goto();
    await skills.createSkillCard.click();

    const detail = new SkillDetailPage(signedIn);
    await expect(detail.nameInput).toBeVisible({ timeout: 15000 });
    await detail.fillAndSave(
      skillName,
      "A skill created through the Skills page UI test.",
      "# Created From UI\n\nStep one. Step two.",
    );

    // Redirects back to the list, where the new card appears.
    await expect(signedIn).toHaveURL(/\/skills$/, { timeout: 15000 });
    await expect(skills.skillCardByName(skillName)).toBeVisible({ timeout: 15000 });

    // Navigate to the composer via a client-side link click -- never
    // page.reload() -- and confirm the '/' palette (a separate SWR
    // consumer of the same /api/skills cache key) already has it.
    await signedIn.locator('a[href="/"]').first().click();
    await signedIn.waitForLoadState("domcontentloaded");

    const editor = signedIn.locator(".ProseMirror").first();
    await expect(editor).toBeVisible({ timeout: 15000 });
    await editor.click();
    await signedIn.keyboard.type("/" + skillName.slice(0, 8));

    const palette = new SkillPalette(signedIn);
    await expect(palette.item(skillName)).toBeVisible({ timeout: 15000 });
  });

  test("a bad name produces a field-level error and creates nothing", async ({ signedIn }) => {
    const detail = new SkillDetailPage(signedIn);
    await detail.goto("new");
    await expect(detail.nameInput).toBeVisible({ timeout: 15000 });

    await detail.fillAndSave(
      "Not A Valid Name!",
      "A description for the bad-name validation test.",
      "# Body",
    );

    await expect(detail.nameError).toBeVisible({ timeout: 15000 });
    await expect(signedIn).toHaveURL(/\/skill\?name=new$/);

    const list = await apiGetSkills(signedIn);
    const names = ((list.items ?? []) as { name: string }[]).map((s) => s.name);
    expect(names).not.toContain("Not A Valid Name!");
  });

  test("an over-long description produces a field-level error", async ({ signedIn }) => {
    const detail = new SkillDetailPage(signedIn);
    await detail.goto("new");
    await expect(detail.nameInput).toBeVisible({ timeout: 15000 });

    await detail.fillAndSave(
      "overlong-description-skill",
      "x".repeat(1030),
      "# Body",
    );

    await expect(detail.descriptionError).toBeVisible({ timeout: 15000 });
    await expect(signedIn).toHaveURL(/\/skill\?name=new$/);
  });

  test("a read-only skill opens disabled, names its owner, and Duplicate yields an editable copy", async ({
    amiro,
    page,
  }) => {
    const skillName = "readonly-duplicate-skill";
    plantSkill(amiro, {
      name: skillName,
      description: "A .claude skill for the duplicate test",
      scope: "user",
      source: ".claude",
    });

    await signIn(page, amiro.accounts.user.token);
    const detail = new SkillDetailPage(page);
    await detail.goto(skillName);

    await expect(detail.readOnlyNotice).toBeVisible({ timeout: 15000 });
    await expect(detail.readOnlyNotice).toContainText(".claude");
    await expect(detail.nameInput).toBeDisabled();
    await expect(detail.descriptionInput).toBeDisabled();
    await expect(detail.bodyTextarea).toBeDisabled();
    await expect(detail.saveButton).toHaveCount(0);

    await detail.duplicateButton.click();

    // No existing ~/.agents/skills/<skillName> in this fresh $HOME, so the
    // duplicate lands under the identical name (service.go's Duplicate
    // only appends "-copy" on an actual collision) -- just now writable.
    await expect(page).toHaveURL(new RegExp(`/skill\\?name=${skillName}`), { timeout: 15000 });
    await expect(detail.readOnlyNotice).toHaveCount(0);
    await expect(detail.descriptionInput).toBeEditable({ timeout: 15000 });
    await expect(detail.bodyTextarea).toBeEditable();
    await expect(detail.deleteButton).toBeVisible();
  });

  test("delete confirms then removes the skill", async ({ signedIn }) => {
    const skillName = "delete-me-skill";

    const detail = new SkillDetailPage(signedIn);
    await detail.goto("new");
    await expect(detail.nameInput).toBeVisible({ timeout: 15000 });
    await detail.fillAndSave(
      skillName,
      "A skill created only to be deleted.",
      "# Delete Me",
    );
    await expect(signedIn).toHaveURL(/\/skills$/, { timeout: 15000 });

    const skills = new SkillsPage(signedIn);
    await skills.skillCardByName(skillName).click();
    await expect(detail.deleteButton).toBeVisible({ timeout: 15000 });
    await detail.deleteButton.click();

    // notify.confirm renders a dialog with a Confirm button.
    await signedIn.getByRole("button", { name: /confirm/i }).click();

    await expect(signedIn).toHaveURL(/\/skills$/, { timeout: 15000 });
    await expect(skills.skillCardByName(skillName)).toHaveCount(0);
  });

  test("`create-agent-button` and `create-agent-card` match zero elements anywhere in the app", async ({
    signedIn,
  }) => {
    const skills = new SkillsPage(signedIn);
    await skills.goto();
    await expect(signedIn.locator('[data-testid="create-agent-button"]')).toHaveCount(0);
    await expect(signedIn.locator('[data-testid="create-agent-card"]')).toHaveCount(0);

    await signedIn.goto("/");
    await signedIn.waitForLoadState("domcontentloaded");
    await expect(signedIn.locator('[data-testid="create-agent-button"]')).toHaveCount(0);
    await expect(signedIn.locator('[data-testid="create-agent-card"]')).toHaveCount(0);
  });
});

test.describe("skills page — generate with AI", () => {
  test.use({
    fakeReply: JSON.stringify({
      name: "generated-skill",
      description: "A generated skill description that explains what and when.",
      body: "# Generated Skill\n\nStep one.",
    }),
  });

  test("Generate populates the form and nothing is written until Save is pressed", async ({
    signedIn,
  }) => {
    const detail = new SkillDetailPage(signedIn);
    await detail.goto("new");
    await expect(detail.generateButton).toBeVisible({ timeout: 15000 });
    await detail.generateButton.click();

    const promptTextarea = signedIn.locator('[data-testid="skill-generate-prompt-textarea"]');
    const submitButton = signedIn.locator('[data-testid="skill-generate-submit-button"]');
    await expect(promptTextarea).toBeVisible({ timeout: 15000 });
    await promptTextarea.fill("a skill that does something specific");
    await submitButton.click();

    await expect(detail.nameInput).toHaveValue("generated-skill", { timeout: 15000 });
    await expect(detail.descriptionInput).not.toHaveValue("");

    // Still on the unsaved editor -- Generate never calls the write API.
    await expect(signedIn).toHaveURL(/\/skill\?name=new$/);

    const list = await apiGetSkills(signedIn);
    const names = ((list.items ?? []) as { name: string }[]).map((s) => s.name);
    expect(names).not.toContain("generated-skill");
  });
});

test.describe("skills page — generate with AI, invalid name", () => {
  test.use({
    fakeReply: JSON.stringify({
      name: "Not A Valid Name!",
      description: "A generated description that is otherwise valid and long enough.",
      body: "# Body",
    }),
  });

  test("a generated invalid name shows a field error instead of a save failure", async ({
    signedIn,
  }) => {
    const detail = new SkillDetailPage(signedIn);
    await detail.goto("new");
    await detail.generateButton.click();

    const promptTextarea = signedIn.locator('[data-testid="skill-generate-prompt-textarea"]');
    const submitButton = signedIn.locator('[data-testid="skill-generate-submit-button"]');
    await expect(promptTextarea).toBeVisible({ timeout: 15000 });
    await promptTextarea.fill("a skill with a bad generated name");
    await submitButton.click();

    await expect(detail.nameInput).toHaveValue("Not A Valid Name!", { timeout: 15000 });
    await expect(detail.nameError).toBeVisible({ timeout: 15000 });
  });
});
