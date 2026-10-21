/**
 * Helpers for the setup chat (src/components/setup-chat): first-run
 * onboarding (journey 1) and Team → New agent (journey 12) run the same chat.
 */
import { type Page, expect } from "@playwright/test";

/** The latest turn of the chat for a step, once its line has streamed in. */
export async function openTurn(page: Page, step: string) {
  const turn = page.getByTestId(`setup-turn-${step}`).last();
  await expect(turn).toBeVisible({ timeout: 20000 });
  await expect(turn.locator("[data-streaming]").first()).toHaveAttribute("data-streaming", "done", {
    timeout: 20000,
  });
  return turn;
}

/** The user's reply bubble under a step's latest turn. */
export function replyOf(page: Page, step: string) {
  return page.getByTestId(`setup-turn-${step}`).last().getByTestId("setup-user-reply");
}
