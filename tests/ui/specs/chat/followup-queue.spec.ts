import { test, expect } from "../../support/fixtures";
import { ChatPage } from "../../pages";

// Follow-up queue: typing Enter while the agent still responds must not be
// swallowed. The draft parks in a Queued chip and flushes as the next turn
// once the live turn settles -- one user turn in, two user turns out, two
// assistant replies.
test.describe("chat follow-up queue", () => {
  test("enter while streaming queues and auto-sends the follow-up", async ({
    signedIn,
  }) => {
    const chat = new ChatPage(signedIn);
    await expect(chat.input.first()).toBeVisible({ timeout: 15000 });

    await chat.sendMessage("First message, please reply briefly.");

    // Wait until the turn is actually live before typing the follow-up --
    // the queue path only engages while isLoading.
    await expect(chat.messagesContainer).toHaveAttribute(
      "data-state",
      "streaming",
      { timeout: 20000 },
    );

    // Type the follow-up into the composer and press Enter. The SDK input
    // must stay editable and the send must park, not vanish.
    const editor = signedIn.locator(".ProseMirror").first();
    await editor.click();
    await editor.fill("Follow-up: and one more thing.");
    await signedIn.keyboard.press("Enter");

    const chip = signedIn.locator('[data-testid="queued-followup-chip"]');
    await expect(chip).toBeVisible({ timeout: 10000 });
    await expect(chip).toContainText("Follow-up: and one more thing.");

    // The live turn settles, the chip clears, and the follow-up flushes as
    // its own turn: two user bubbles, and eventually two assistant replies.
    await expect(chip).toBeHidden({ timeout: 30000 });
    const userBubbles = signedIn.locator(
      '[data-testid="message-content"][data-role="user"]',
    );
    await expect(userBubbles).toHaveCount(2, { timeout: 30000 });
    const assistantBubbles = chat.assistantMessageBubbles();
    await expect(assistantBubbles).toHaveCount(2, { timeout: 60000 });
  });
});
