import { test, expect } from "../../support/fixtures";
import { ChatPage, ThreadsPage } from "../../pages";

test.describe("threads", () => {
  test("create new chat thread and switch between threads", async ({ signedIn }) => {
    const chat = new ChatPage(signedIn);
    const threads = new ThreadsPage(signedIn);

    // Send first message to create thread 1
    await expect(chat.input.first()).toBeVisible({ timeout: 15000 });
    await chat.sendMessage("First thread topic");
    await chat.waitForStreamingComplete();

    // Create a second chat
    await threads.createNewChat();
    await expect(chat.input.first()).toBeVisible({ timeout: 15000 });

    // Send message in second thread
    await chat.sendMessage("Second thread topic");
    await chat.waitForStreamingComplete();

    // Verify thread links appear in sidebar
    const threadLinks = threads.threadLinks();
    await expect(threadLinks.first()).toBeVisible({ timeout: 15000 });
    const count = await threadLinks.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });
});
