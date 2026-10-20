/** Chat helpers shared by every journey that talks to the agent. */
import { type Locator, type Page, expect } from "@playwright/test";
import { loadConfig } from "./config";

export function composer(page: Page): Locator {
  return page.locator('main [contenteditable="true"]').first();
}

export function assistantMessages(page: Page): Locator {
  return page.locator("main article");
}

export async function newChat(page: Page) {
  await page.goto("/");
  await expect(composer(page)).toBeVisible({ timeout: 30000 });
}

/**
 * Pick the configured model in the composer's model picker, falling back to
 * `provider.fallbackModel` when the provider does not offer it. Returns the
 * model actually selected.
 */
export async function selectModel(page: Page, model?: string): Promise<string> {
  const { provider } = loadConfig();
  const current = page.getByTestId("selected-model-name").first();
  const shown = (await current.innerText().catch(() => "")).trim();
  const wanted = model ? [model] : [provider.model, provider.fallbackModel].filter(Boolean);
  if (wanted.includes(shown)) return shown;
  await page.getByTestId("model-selector-button").first().click();
  for (const m of wanted) {
    await page.getByTestId("model-search-input").fill(m);
    const option = page.getByTestId(`model-option-${provider.id}-${m}`);
    if (await option.isVisible({ timeout: 3000 }).catch(() => false)) {
      await option.click();
      await expect(current).toHaveText(m);
      return m;
    }
  }
  throw new Error(`none of ${wanted.join(", ")} is offered by ${provider.id} in the model picker`);
}

/** Type like a user (so the video shows it) and send with Enter. */
export async function send(page: Page, text: string) {
  const box = composer(page);
  await box.click();
  await box.pressSequentially(text, { delay: 8 });
  await page.keyboard.press("Enter");
}

/**
 * Wait until the agent has finished its turn: a new assistant message exists,
 * nothing says "Working…", and the text has been stable for a few seconds.
 * Returns the full text of the last assistant message.
 */
export async function waitForReply(page: Page, opts: { before?: number; timeoutMs?: number; stableMs?: number } = {}) {
  const timeout = opts.timeoutMs ?? loadConfig().timeouts.agentReplyMs;
  const stableMs = opts.stableMs ?? 4000;
  const before = opts.before ?? 0;
  const msgs = assistantMessages(page);
  const errorsBefore = await chatErrors(page).count();
  await expect
    .poll(
      async () => {
        await throwOnChatError(page, errorsBefore);
        return msgs.count();
      },
      { timeout, message: "agent never replied" },
    )
    .toBeGreaterThan(before);

  const end = Date.now() + timeout;
  let last = "";
  let since = Date.now();
  while (Date.now() < end) {
    await throwOnChatError(page, errorsBefore);
    const working = await page.getByText(/^Working…/).first().isVisible().catch(() => false);
    const text = await msgs.last().innerText().catch(() => "");
    if (text !== last) {
      last = text;
      since = Date.now();
    } else if (!working && text.trim() && Date.now() - since >= stableMs) {
      return text;
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`agent reply did not settle within ${timeout}ms; last text: ${last.slice(0, 300)}`);
}

/** Send a prompt and wait for the full reply. */
export async function ask(page: Page, text: string, opts: { timeoutMs?: number } = {}) {
  const before = await assistantMessages(page).count();
  await send(page, text);
  return waitForReply(page, { before, ...opts });
}

/** Names of every tool call rendered in the transcript so far (e.g. "amiro/search_provider_configure"). */
export async function toolCallsShown(page: Page): Promise<string> {
  return (await page.locator("main").innerText()).replace(/\s+/g, " ");
}

/** The red "Chat Error" block the UI shows when a turn fails. */
export function chatErrors(page: Page): Locator {
  return page.locator("main").getByText("Chat Error", { exact: true });
}

/** Fail fast (with the UI's own message) when a new chat error appears. */
export async function throwOnChatError(page: Page, before = 0) {
  const errs = chatErrors(page);
  if ((await errs.count()) > before) {
    const msg = await errs.last().locator("xpath=../..").innerText().catch(() => "Chat Error");
    throw new Error(`chat turn failed in the UI: ${msg.replace(/\s+/g, " ").slice(0, 300)}`);
  }
}
