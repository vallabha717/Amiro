/**
 * Scenes: Admin. Web search settings with a live test query, the secure
 * secret card the agent uses when it needs a key, voice settings, the
 * credentials vault, usage and the debug terminal.
 */
import { askAndShow, expect, freshChat, hold, scene, test } from "../support";

test("admin: web search engines and a live test", async ({ page, step, amiro }) => {
  scene("admin-search");

  await step("Admin → Search Providers: the active engine (Bing here) and every other engine", async () => {
    await page.goto("/admin/search");
    await hold(page, 3500);
  });

  await step("Test the engine → Run Connectivity Test: a live query, its latency and result count", async () => {
    const { body } = await amiro.api<Array<{ id: string; isActive: boolean }>>("/api/search/providers");
    const active = body.find((p) => p.isActive) ?? body[0];
    await page.goto(`/admin/search/test?id=${encodeURIComponent(active.id)}`);
    await page.getByTestId("run-search-test").click();
    await expect(page.getByTestId("search-test-result")).toBeVisible({ timeout: 60000 });
    await hold(page, 3500);
  });

  await step("Then just ask — Amiro searches with that engine", async () => {
    await freshChat(page);
    await askAndShow(page, "What's the weather forecast for Bengaluru this weekend? Search the web and keep it to three lines with the source.");
    await hold(page, 3000);
  });
});

test("secrets: the agent asks for a key in a secure card, never in chat", async ({ page, step }) => {
  scene("secret-card");

  await step("Ask Amiro to switch to an engine that needs a key", async () => {
    await freshChat(page);
    await askAndShow(page, "Switch my web search to Brave Search, please.");
  });

  await step("It replies with a secure card: the key goes straight to the encrypted vault", async () => {
    const card = page.getByTestId("secret-prompt-card").last();
    await expect(card).toBeVisible({ timeout: 60000 });
    await card.scrollIntoViewIfNeeded();
    await expect(card.locator('input[type="password"]').first()).toBeVisible();
    await hold(page, 5000);
  });

  await step("Admin → Credentials: every stored secret, masked — values are never shown back", async () => {
    await page.goto("/admin/credentials");
    await expect(page.getByRole("heading", { name: "Credentials", level: 1 })).toBeVisible();
    await hold(page, 4000);
  });
});

// The Debug terminal is left out on purpose: its prompt shows the real path
// of the recording machine's home folder.
test("admin: voice, notifications and usage", async ({ page, step }) => {
  scene("admin-tour");

  await step("Admin → Voice & Speech: pick speech-to-text and text-to-speech engines and a voice", async () => {
    await page.goto("/admin/voice");
    await hold(page, 3500);
  });

  await step("Admin → Notifications: which events notify you, quiet hours, Telegram / Slack / Discord", async () => {
    await page.goto("/admin/notifications");
    await hold(page, 3500);
    await page.mouse.move(720, 450);
    await page.mouse.wheel(0, 500);
    await hold(page, 2000);
  });

  await step("Admin → Usage & Users: tokens and estimated cost per model", async () => {
    await page.goto("/admin/usage");
    await hold(page, 3500);
  });
});
