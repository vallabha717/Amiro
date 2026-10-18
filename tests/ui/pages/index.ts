import type { Locator, Page } from "@playwright/test";
import { expect } from "@playwright/test";

export class SignInPage {
  readonly page: Page;
  readonly emailInput: Locator;
  readonly passwordInput: Locator;
  readonly submitButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.emailInput = page.locator('[data-testid="signin-email-input"]');
    this.passwordInput = page.locator('[data-testid="signin-password-input"]');
    this.submitButton = page.locator('[data-testid="signin-submit-button"]');
  }

  async goto() {
    await this.page.goto("/sign-in");
    await this.page.waitForLoadState("domcontentloaded");
  }

  async signIn(email: string, pass: string) {
    await this.emailInput.fill(email);
    await this.passwordInput.fill(pass);
    await this.submitButton.click();
  }
}

// First-run owner setup (/setup): the single-account creation flow shown on a
// fresh instance. There is no sign-up page anymore.
export class SetupPage {
  readonly page: Page;
  readonly emailInput: Locator;
  readonly passwordInput: Locator;
  readonly confirmInput: Locator;
  readonly submitButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.emailInput = page.locator('[data-testid="setup-email-input"]');
    this.passwordInput = page.locator('[data-testid="setup-password-input"]');
    this.confirmInput = page.locator('[data-testid="setup-confirm-input"]');
    this.submitButton = page.locator('[data-testid="setup-submit-button"]');
  }

  async goto() {
    await this.page.goto("/setup");
    await this.page.waitForLoadState("domcontentloaded");
  }

  async setup(identifier: string, pass: string) {
    await this.emailInput.fill(identifier);
    await this.passwordInput.fill(pass);
    await this.confirmInput.fill(pass);
    await this.submitButton.click();
  }
}

export class OnboardingPage {
  readonly page: Page;
  readonly apiKeyInput: Locator;
  readonly baseUrlInput: Locator;
  readonly saveButton: Locator;
  readonly skipButton: Locator;
  readonly finishButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.apiKeyInput = page.locator('[data-testid="onboarding-api-key-input"]');
    this.baseUrlInput = page.locator(
      '[data-testid="onboarding-base-url-input"]',
    );
    this.saveButton = page.locator('[data-testid="onboarding-save-button"]');
    this.skipButton = page.locator('[data-testid="onboarding-skip-button"]');
    this.finishButton = page.locator(
      '[data-testid="onboarding-finish-button"]',
    );
  }

  async goto() {
    await this.page.goto("/onboarding");
    await this.page.waitForLoadState("domcontentloaded");
  }

  async selectProvider(id: string) {
    await this.page
      .locator(`[data-testid="onboarding-provider-${id}"]`)
      .click();
  }

  async configure(apiKey: string, baseUrl?: string) {
    await this.apiKeyInput.fill(apiKey);
    if (baseUrl && (await this.baseUrlInput.isVisible())) {
      await this.baseUrlInput.fill(baseUrl);
    }
    await this.saveButton.click();
  }

  async finish() {
    await this.finishButton.click();
  }

  async skip() {
    await this.skipButton.click();
  }
}

export class ChatPage {
  readonly page: Page;
  readonly input: Locator;
  readonly sendButton: Locator;
  readonly messagesContainer: Locator;
  readonly greeting: Locator;
  readonly modelSelector: Locator;

  constructor(page: Page) {
    this.page = page;
    this.input = page.locator(
      '[data-testid="chat-input"] .ProseMirror, [data-testid="chat-input"]',
    );
    this.sendButton = page.locator('[data-testid="chat-send-button"]');
    this.messagesContainer = page.locator(
      '[data-testid="chat-messages-container"]',
    );
    this.greeting = page.locator('[data-testid="chat-greeting"]');
    this.modelSelector = page.locator('[data-testid="model-selector-button"]');
  }

  async goto(threadId?: string) {
    await this.page.goto(threadId ? `/?thread=${threadId}` : "/");
    await this.page.waitForLoadState("domcontentloaded");
  }

  async sendMessage(text: string) {
    const editor = this.page.locator(".ProseMirror").first();
    if (await editor.isVisible()) {
      await editor.click();
      await editor.fill(text);
    } else {
      await this.input.first().fill(text);
    }
    await this.sendButton.click();
  }

  async waitForStreamingComplete() {
    await expect(this.messagesContainer).toBeVisible({ timeout: 20000 });
    await expect(this.messagesContainer).toHaveAttribute(
      "data-state",
      "ready",
      { timeout: 30000 },
    );
  }

  messageBubbles() {
    return this.page.locator('[data-testid="message-content"]');
  }

  // Assistant-authored bubbles only -- distinct from the user's own echoed
  // message, which also carries data-testid="message-content". Without
  // this filter, a test asserting on "a bubble appeared" is satisfied by
  // the user's own message alone, even when the assistant turn errored.
  assistantMessageBubbles() {
    return this.page.locator(
      '[data-testid="message-content"][data-role="assistant"]',
    );
  }
}

export class ThreadsPage {
  readonly page: Page;
  readonly newChatButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.newChatButton = page.locator(
      '[data-testid="sidebar-new-chat-button"]',
    );
  }

  threadLinks() {
    return this.page.locator('[data-testid="sidebar-thread-link"]');
  }

  async createNewChat() {
    await expect(this.newChatButton).toBeVisible({ timeout: 15000 });
    await this.newChatButton.dispatchEvent("click");
    await this.page.waitForLoadState("domcontentloaded");
  }
}

export class SkillsPage {
  readonly page: Page;
  readonly createSkillButton: Locator;
  readonly createSkillCard: Locator;

  constructor(page: Page) {
    this.page = page;
    this.createSkillButton = page.locator(
      '[data-testid="create-skill-button"]',
    );
    this.createSkillCard = page.locator('[data-testid="create-skill-card"]');
  }

  async goto() {
    await this.page.goto("/skills");
    await this.page.waitForLoadState("domcontentloaded");
  }

  skillCards() {
    return this.page.locator('[data-testid="skill-card"]');
  }

  skillCardByName(name: string) {
    return this.page.locator(
      `[data-testid="skill-card"][data-item-name="${name}"]`,
    );
  }
}

export class SkillDetailPage {
  readonly page: Page;
  readonly nameInput: Locator;
  readonly descriptionInput: Locator;
  readonly bodyTextarea: Locator;
  readonly saveButton: Locator;
  readonly deleteButton: Locator;
  readonly duplicateButton: Locator;
  readonly nameError: Locator;
  readonly descriptionError: Locator;
  readonly readOnlyNotice: Locator;
  readonly generateButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.nameInput = page.locator('[data-testid="skill-name-input"]');
    this.descriptionInput = page.locator(
      '[data-testid="skill-description-input"]',
    );
    this.bodyTextarea = page.locator('[data-testid="skill-body-textarea"]');
    this.saveButton = page.locator('[data-testid="skill-save-button"]');
    this.deleteButton = page.locator('[data-testid="skill-delete-button"]');
    this.duplicateButton = page.locator(
      '[data-testid="skill-duplicate-button"]',
    );
    this.nameError = page.locator('[data-testid="skill-name-error"]');
    this.descriptionError = page.locator(
      '[data-testid="skill-description-error"]',
    );
    this.readOnlyNotice = page.locator('[data-testid="skill-readonly-notice"]');
    this.generateButton = page.locator(
      '[data-testid="skill-generate-with-ai-button"]',
    );
  }

  async goto(name?: string) {
    await this.page.goto(
      name ? `/skill?name=${encodeURIComponent(name)}` : "/skill?name=new",
    );
    await this.page.waitForLoadState("domcontentloaded");
  }

  async fillAndSave(name: string, description: string, body: string) {
    await this.nameInput.fill(name);
    await this.descriptionInput.fill(description);
    await this.bodyTextarea.fill(body);
    await this.saveButton.click();
  }
}

export class GenerateSkillDialog {
  readonly page: Page;
  readonly promptTextarea: Locator;
  readonly submitButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.promptTextarea = page.locator(
      '[data-testid="skill-generate-prompt-textarea"]',
    );
    this.submitButton = page.locator(
      '[data-testid="skill-generate-submit-button"]',
    );
  }

  async generate(prompt: string) {
    await this.promptTextarea.fill(prompt);
    await this.submitButton.click();
  }
}

export class McpPage {
  readonly page: Page;
  readonly addServerButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.addServerButton = page.locator(
      '[data-testid="add-mcp-server-button"]',
    );
  }

  async goto() {
    await this.page.goto("/mcp");
    await this.page.waitForLoadState("domcontentloaded");
  }

  serverCards() {
    return this.page.locator('[data-testid="mcp-server-card"]');
  }
}

export class ArchivePage {
  readonly page: Page;
  readonly archivePage: Locator;
  readonly archiveTitle: Locator;
  readonly archiveEmpty: Locator;

  constructor(page: Page) {
    this.page = page;
    this.archivePage = page.locator('[data-testid="archive-page"]');
    this.archiveTitle = page.locator('[data-testid="archive-title"]');
    this.archiveEmpty = page.locator('[data-testid="archive-empty"]');
  }

  async goto(id?: string) {
    await this.page.goto(id ? `/archive?id=${id}` : "/archive");
    await this.page.waitForLoadState("domcontentloaded");
  }
}

export class AdminPage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  async goto(subpath = "") {
    await this.page.goto(subpath ? `/admin/${subpath}` : "/admin");
    await this.page.waitForLoadState("domcontentloaded");
  }

  sidebarLink(id: string) {
    return this.page.locator(`[data-testid="admin-sidebar-link-${id}"]`);
  }
}

export class ExportPage {
  readonly page: Page;
  readonly exportPreview: Locator;
  readonly exportTitle: Locator;
  readonly commentForm: Locator;
  readonly commentSubmit: Locator;

  constructor(page: Page) {
    this.page = page;
    this.exportPreview = page.locator('[data-testid="export-preview"]');
    this.exportTitle = page.locator('[data-testid="export-title"]');
    this.commentForm = page.locator('[data-testid="comment-form"]');
    this.commentSubmit = page.locator('[data-testid="comment-submit"]');
  }

  async goto(id: string) {
    await this.page.goto(`/export?id=${id}`);
    await this.page.waitForLoadState("domcontentloaded");
  }
}

export class SettingsPage {
  readonly page: Page;
  readonly userButton: Locator;
  readonly settingsMenuItem: Locator;
  readonly content: Locator;
  readonly nameInput: Locator;
  readonly saveChangesButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.userButton = page
      .locator('[data-testid="sidebar-user-button"]')
      .first();
    this.settingsMenuItem = page.locator(
      '[data-testid="user-settings-menu-item"]',
    );
    this.content = page.locator('[data-testid="user-settings-drawer"]');
    this.nameInput = page.locator('[data-testid="user-name-input"]');
    this.saveChangesButton = page.locator(
      '[data-testid="save-changes-button"]',
    );
  }

  async open() {
    await expect(this.userButton).toBeVisible({ timeout: 15000 });
    await this.userButton.click();
    await expect(this.settingsMenuItem).toBeVisible({ timeout: 15000 });
    await this.settingsMenuItem.click();
    await expect(this.content).toBeVisible({ timeout: 15000 });
  }
}

export class SkillPalette {
  readonly page: Page;
  readonly container: Locator;
  readonly emptyState: Locator;
  readonly errorState: Locator;
  readonly loadingState: Locator;
  readonly groupProject: Locator;
  readonly groupUser: Locator;

  constructor(page: Page) {
    this.page = page;
    this.container = page.locator('[data-testid="skill-palette"]');
    this.emptyState = page.locator('[data-testid="skill-palette-empty"]');
    this.errorState = page.locator('[data-testid="skill-palette-error"]');
    this.loadingState = page.locator('[data-testid="skill-palette-loading"]');
    this.groupProject = page.locator(
      '[data-testid="skill-palette-group-project"]',
    );
    this.groupUser = page.locator('[data-testid="skill-palette-group-user"]');
  }

  item(name: string): Locator {
    return this.page.locator(`[data-testid="skill-palette-item-${name}"]`);
  }

  sourceBadge(source: string): Locator {
    return this.page.locator(`[data-testid="skill-palette-source-${source}"]`);
  }

  chip(name: string): Locator {
    return this.page.locator(`[data-testid="skill-chip-${name}"]`);
  }

  chipRemoveButton(name: string): Locator {
    return this.page.locator(`[data-testid="skill-chip-remove-${name}"]`);
  }

  async selectItem(name: string) {
    const itemLocator = this.item(name);
    await expect(itemLocator).toBeVisible({ timeout: 15000 });
    await itemLocator.click();
  }

  async removeChip(name: string) {
    const removeBtn = this.chipRemoveButton(name);
    await expect(removeBtn).toBeVisible({ timeout: 15000 });
    await removeBtn.click();
  }
}

export class UserSettingsPage {
  readonly page: Page;
  readonly sidebarUserButton: Locator;
  readonly menuItem: Locator;
  readonly drawer: Locator;
  readonly closeButton: Locator;
  readonly trustCard: Locator;
  readonly githubCard: Locator;
  readonly githubStatusBadge: Locator;
  readonly githubTokenInput: Locator;
  readonly githubConnectButton: Locator;
  readonly githubDisconnectButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.sidebarUserButton = page.locator(
      '[data-testid="sidebar-user-button"]',
    );
    this.menuItem = page.locator('[data-testid="user-settings-menu-item"]');
    this.drawer = page.locator('[data-testid="user-settings-drawer"]');
    this.closeButton = page.locator(
      '[data-testid="close-user-settings-button"]',
    );
    this.trustCard = page.locator(
      '[data-testid="workspace-trust-settings-card"]',
    );
    this.githubCard = page.locator('[data-testid="github-connect-card"]');
    this.githubStatusBadge = this.githubCard.locator(
      '[data-testid="github-status-badge"]',
    );
    this.githubTokenInput = this.githubCard.locator(
      '[data-testid="github-token-input"]',
    );
    this.githubConnectButton = this.githubCard.locator(
      '[data-testid="github-connect-button"]',
    );
    this.githubDisconnectButton = this.githubCard.locator(
      '[data-testid="github-disconnect-button"]',
    );
  }

  async open() {
    await this.page.goto("/");
    await this.sidebarUserButton.click();
    await this.menuItem.click();
    await expect(this.drawer).toBeVisible({ timeout: 15000 });
  }

  grantRow(root: string): Locator {
    return this.trustCard
      .locator('[data-testid="workspace-trust-grant-row"]')
      .filter({ hasText: root });
  }

  revokeButtonFor(root: string): Locator {
    return this.grantRow(root).locator(
      '[data-testid="workspace-trust-revoke-button"]',
    );
  }
}
