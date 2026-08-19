import { test, expect } from "../../support/fixtures";
import { ChatPage } from "../../pages";

// The backend behind `signedIn` now has a real (fake) provider seeded --
// see tests/cmd/amirotest/backend_cmd.go's startFakeProvider and
// fakeprovider_cmd.go -- so an assistant reply is real content, not a "no
// keys found" error frame. Both a user bubble and an assistant bubble
// share data-testid="message-content"; only data-role="assistant"
// distinguishes them (message-parts.tsx), which is why this spec asserts
// on assistantMessageBubbles() and its text, not just "a bubble appeared".
test.describe("chat", () => {
  test("send message streams tokens into bubble and completes", async ({ signedIn }) => {
    const chat = new ChatPage(signedIn);
    await expect(chat.input.first()).toBeVisible({ timeout: 15000 });

    await chat.sendMessage("Hello Amiro, what is 2 + 2?");

    // Verify messages appear in container
    await expect(chat.messagesContainer).toBeVisible({ timeout: 10000 });
    const assistantBubbles = chat.assistantMessageBubbles();
    await expect(assistantBubbles.first()).toBeVisible({ timeout: 15000 });

    // Wait for streaming completion attribute
    await chat.waitForStreamingComplete();

    // The assistant bubble must carry the fake provider's actual reply --
    // not be empty, and not merely be the user's own echoed message.
    await expect(assistantBubbles.first()).toContainText("fake test provider", { timeout: 15000 });
    const count = await assistantBubbles.count();
    expect(count).toBeGreaterThanOrEqual(1);

    // Verify thread persistence across reload
    await signedIn.reload();
    await signedIn.waitForLoadState("domcontentloaded");
    await expect(chat.assistantMessageBubbles().first()).toContainText("fake test provider", { timeout: 15000 });
  });
});
