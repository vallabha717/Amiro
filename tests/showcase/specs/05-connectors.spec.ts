/**
 * Scenes: connectors. Add a real public MCP server (DeepWiki, no key) from
 * the Connectors page and use it in chat; then let the agent add one itself.
 */
import { askAndShow, expect, freshChat, hold, readThrough, scene, test } from "../support";

test("connectors: add an MCP server and use it in chat", async ({ page, step }) => {
  scene("connectors-add");

  await step("Sidebar → Connectors → Add custom", async () => {
    await page.goto("/connectors");
    await expect(page.getByRole("heading", { name: "Connectors", level: 1 })).toBeVisible();
    await hold(page, 1500);
    await page.getByRole("button", { name: "Add custom" }).click();
  });

  await step("Name it, paste the server URL, pick the auth style (DeepWiki needs none) → Connect", async () => {
    const d = page.getByRole("dialog", { name: "Add a custom connector" });
    await d.getByLabel("Name").pressSequentially("deepwiki", { delay: 50 });
    await d.getByLabel("Server URL").pressSequentially("https://mcp.deepwiki.com/mcp", { delay: 25 });
    await d.getByRole("button", { name: "None" }).click();
    await hold(page, 1200);
    await d.getByRole("button", { name: "Connect" }).click();
    await expect(d).toBeHidden({ timeout: 60000 });
  });

  await step("Connected: the card lists the server's tools", async () => {
    await page.getByRole("button", { name: "Refresh" }).click().catch(() => {});
    await page.locator("main").getByText("deepwiki", { exact: true }).first().scrollIntoViewIfNeeded();
    await hold(page, 3500);
  });

  await step("Use it: ask about a real GitHub repo — Amiro calls the connector's tools", async () => {
    await freshChat(page);
    await askAndShow(
      page,
      "Use the deepwiki connector: for the GitHub repo tokio-rs/tokio, explain in 5 short bullets how the runtime schedules tasks across threads.",
    );
    await readThrough(page);
    await hold(page, 2500);
  });
});

test("connectors: the agent connects one for you", async ({ page, step }) => {
  scene("connectors-agent");

  await step("Ask in plain words: \"connect the Context7 docs server\"", async () => {
    await freshChat(page);
    await askAndShow(
      page,
      "Please connect the Context7 MCP server for me (https://mcp.context7.com/mcp, no key needed) so you can read up-to-date library docs.",
    );
    await hold(page, 2000);
  });

  await step("Then use it straight away", async () => {
    await askAndShow(page, "Using Context7, show me the current way to define a route with a path parameter in axum, as a short code example.");
    await readThrough(page);
  });

  await step("Connectors page: the agent's new connector sits next to yours", async () => {
    await page.goto("/connectors");
    await hold(page, 3500);
  });
});
