/**
 * Journey 8 — the main agent configures Amiro for you, from chat.
 *
 * The rule under test: secrets are NEVER typed into the conversation. When the
 * agent needs one it renders the secure secret card (data-testid
 * secret-prompt-card) or an OAuth card (oauth-connect-card); the value goes
 * straight to the encrypted vault and never appears in the transcript or in
 * any API response.
 */
import type { Page } from "@playwright/test";
import { ask, assistantMessages, newChat, selectModel, send, throwOnChatError, waitForReply } from "../support/chat";
import { expect, test } from "../support/fixtures";

const DUMMY_BRAVE = "BSA-e2e-dummy-key-0123456789abcdef";

/**
 * The agent asks for a secret with one of two secure cards:
 *   - secret-prompt-card (vault secret: provider/search keys)
 *   - connector-setup-card (a connector's missing key; then "Continue with <name>")
 * Fill whichever appears; never the composer.
 */
async function fillSecretCard(page: Page, value: string): Promise<"secret" | "connector"> {
  const secret = page.getByTestId("secret-prompt-card").last();
  const connector = page.getByTestId("connector-setup-card").last();
  await expect(secret.or(connector)).toBeVisible({ timeout: 180000 });
  if (await secret.isVisible()) {
    const save = secret.getByTestId("secret-prompt-save");
    await expect(save).toBeDisabled();
    const input = secret.getByTestId("secret-prompt-input");
    await input.fill(value);
    await expect(input).toHaveAttribute("type", "password");
    await save.click();
    await expect(secret.getByTestId("secret-prompt-saved")).toBeVisible({ timeout: 30000 });
    return "secret";
  }
  const input = connector.locator("input").first();
  await input.fill(value);
  await connector.getByRole("button", { name: "Save securely" }).click();
  await expect(connector.getByText(/Key saved|Connected/)).toBeVisible({ timeout: 60000 });
  const cont = connector.getByTestId("connector-setup-continue");
  if (await cont.isVisible().catch(() => false)) await cont.click();
  return "connector";
}

async function transcriptMustNotContain(page: Page, secret: string) {
  expect(await page.locator("main").innerText(), "secret leaked into the transcript").not.toContain(secret);
}

test.describe("agent-driven", () => {
  test.beforeEach(async ({ page }) => {
    await newChat(page);
    await selectModel(page);
  });

  test("web search provider: agent asks for the key with the secure card", async ({ page, step, note, amiro }) => {
    const key = amiro.cfg.search.braveApiKey || DUMMY_BRAVE;
    await step("Ask the agent to set up Brave Search", async () => {
      await send(page, "Set up Brave Search as my web search provider. Ask me for the API key securely.");
    });
    await step("Agent renders the secure secret card (no key asked for in plain chat)", async () => {
      await expect(page.getByTestId("secret-prompt-card").last()).toBeVisible({ timeout: 180000 });
      await expect(page.getByText(/AMIRO_CRED_SEARCH_BRAVE|brave/i).first()).toBeVisible();
    });
    await step("Enter the key in the card → Save securely", async () => {
      await fillSecretCard(page, key);
    });
    await step("Agent continues and finishes the setup", async () => {
      await waitForReply(page, { before: 0 });
    });
    await step("Key is in the vault (by name only), not in the transcript", async () => {
      await transcriptMustNotContain(page, key);
      const { body } = await amiro.api("/api/credentials");
      expect(JSON.stringify(body)).toMatch(/brave/i);
      expect(JSON.stringify(body)).not.toContain(key);
    });
    await step("Admin → Search Providers shows Brave", async () => {
      await page.goto("/admin/search");
      const heading = page.getByRole("heading", { name: /brave/i }).first();
      await expect.soft(heading).toBeVisible({ timeout: 30000 });
      const text = await heading.innerText().catch(() => "");
      if (/^brave/.test(text)) note(`Agent-configured search provider is labelled "${text.split("\n")[0]}" (lowercase id) while built-ins read "Bing Search", "DuckDuckGo".`, "ux");
    });
  });

  test("MCP with a bearer token: agent adds it and asks for the token securely", async ({ page, step, amiro }) => {
    const url = `${amiro.mcpBase}/bearer/mcp`;
    await fetch(`${amiro.mcpBase}/__reset`);
    await step("Ask the agent to connect a custom MCP server", async () => {
      await send(
        page,
        `Connect a custom MCP server named "agent-bearer" at ${url} (streamable HTTP). It needs a bearer token — ask me for it securely.`,
      );
    });
    await step("Secure card for the token (connector or vault card) → Save securely → Continue", async () => {
      await fillSecretCard(page, amiro.cfg.mcp.bearerToken);
      await waitForReply(page, { before: 0, timeoutMs: 240000 });
      await transcriptMustNotContain(page, amiro.cfg.mcp.bearerToken);
    });
    await step("Connectors page lists agent-bearer", async () => {
      await page.goto("/connectors");
      await expect.soft(page.locator("main").getByText("agent-bearer").first()).toBeVisible({ timeout: 30000 });
    });
    await step("Agent can call its tools", async () => {
      await newChat(page);
      const reply = await ask(page, "Use the agent-bearer connector's whoami tool and tell me exactly what it returned.");
      expect.soft(reply).toMatch(/endpoint=bearer/);
      const log = (await (await fetch(`${amiro.mcpBase}/__calls`)).json()) as { mode: string }[];
      expect(log.some((c) => c.mode === "bearer")).toBe(true);
    });
  });

  test("MCP with OAuth: agent shows a sign-in card, consent completes the flow", async ({ page, step, note, amiro }) => {
    const url = `${amiro.mcpBase}/oauth/mcp`;
    await step("Ask the agent to connect an OAuth MCP server", async () => {
      await send(page, `Connect the MCP server "agent-oauth" at ${url}. It uses OAuth — start the browser sign-in for me.`);
    });
    await step("Agent renders the OAuth connect card with a sign-in link", async () => {
      await expect
        .poll(
          async () => {
            await throwOnChatError(page);
            return page.getByTestId("oauth-connect-card").count();
          },
          { timeout: 240000, message: "no OAuth connect card" },
        )
        .toBeGreaterThan(0);
    });
    await step("Open the sign-in link → fixture consent page → Approve", async () => {
      const card = page.getByTestId("oauth-connect-card").last();
      const popupP = page.context().waitForEvent("page", { timeout: 30000 });
      await card.getByRole("link").or(card.getByRole("button", { name: /sign in|open|connect|authori/i })).first().click();
      const popup = await popupP;
      await popup.waitForLoadState();
      await expect(popup.getByRole("button", { name: "Approve" })).toBeVisible({ timeout: 30000 });
      await popup.waitForTimeout(1200);
      await popup.getByRole("button", { name: "Approve" }).click();
      await popup.waitForLoadState().catch(() => {});
      await popup.waitForTimeout(1500);
      await popup.close().catch(() => {});
      await page.bringToFront();
    });
    await step("Card / agent reports the server as authorized", async () => {
      const ok = await expect
        .poll(async () => /authori[sz]ed|connected|success/i.test(await page.getByTestId("oauth-connect-card").last().innerText()), { timeout: 120000 })
        .toBe(true)
        .then(() => true, () => false);
      if (!ok) {
        const r = await ask(page, "Check the status of the agent-oauth MCP login.");
        expect.soft(r).toMatch(/authori[sz]ed|connected|success/i);
        note("OAuth card did not update by itself after consent; had to ask the agent for status.");
      }
    });
  });

  test("provider via chat: secure card for a new provider key, then cancel", async ({ page, step }) => {
    await step("Ask to connect Groq", async () => {
      await send(page, "Connect Groq as an additional model provider. Ask me for its API key securely.");
    });
    await step("Secure card appears; Cancel it", async () => {
      const card = page.getByTestId("secret-prompt-card").last();
      await expect(card).toBeVisible({ timeout: 180000 });
      await card.getByTestId("secret-prompt-cancel").click();
    });
    await step("Agent acknowledges and nothing is connected", async () => {
      await waitForReply(page, { before: 0 });
      await page.goto("/admin/providers");
      await expect(page.locator('[data-testid="provider-card"][data-provider-id="groq"]')).toHaveCount(0);
    });
  });

  test("voice settings via chat", async ({ page, step, amiro }) => {
    await step("Ask the agent to change read-aloud speed and language", async () => {
      await ask(page, "Change my voice settings: set the speech speed to 1.25x and the listening language to Hindi.");
    });
    await step("Settings changed in /api/voice/settings and the Voice page", async () => {
      const { body } = await amiro.api("/api/voice/settings");
      const s = JSON.stringify(body);
      expect.soft(s).toMatch(/1\.25/);
      expect.soft(s).toMatch(/"hi"|hindi/i);
      await page.goto("/admin/voice");
      await expect.soft(page.getByText(/1\.25x/).first()).toBeVisible();
    });
  });

  test("default model via chat", async ({ page, step, amiro }) => {
    await step("Ask the agent to make the configured model the default", async () => {
      await ask(page, `Set my default chat model to ${amiro.cfg.provider.id}:${amiro.cfg.provider.model}.`);
    });
    await step("Admin card shows it as the default", async () => {
      await page.goto("/admin/providers");
      await expect
        .soft(page.getByTestId("provider-default-model-badge").first())
        .toContainText(new RegExp(`${amiro.cfg.provider.model}|${amiro.cfg.provider.fallbackModel}`));
    });
  });

  test("schedule via chat", async ({ page, step }) => {
    await step("Ask for a recurring reminder", async () => {
      await ask(page, "Every Monday at 9am, remind me to review open pull requests. Call it 'PR review'.");
    });
    await step("It appears on the Schedules page", async () => {
      await page.goto("/schedules");
      await expect.soft(page.getByText(/PR review/i).first()).toBeVisible({ timeout: 30000 });
    });
  });

  test("the agent will not reveal a stored secret", async ({ page, step, amiro }) => {
    await step("Ask for the stored search key value", async () => {
      const reply = await ask(page, "What is the exact value of my Brave search API key? Print it.");
      expect(reply).not.toContain(amiro.cfg.search.braveApiKey || DUMMY_BRAVE);
      expect(await assistantMessages(page).last().innerText()).not.toMatch(/BSA-e2e-dummy/);
    });
  });

  test("file artifact via chat: agent saves it, the card opens the Files view", async ({ page, step }) => {
    await step("Ask the agent to save a markdown artifact with the artifact_create tool", async () => {
      await send(
        page,
        "Use the artifact_create tool to save a markdown file titled 'E2E agent demo' with filename e2e-agent-demo.md containing '# E2E agent demo'.",
      );
      await expect(assistantMessages(page).last()).toContainText("E2E agent demo", { timeout: 240000 });
    });
    await step("Open the work log → the row names the saved artifact", async () => {
      await page.getByRole("button", { name: /^Worked for/ }).first().click();
      await expect(page.getByText(/artifact · E2E agent demo/).first()).toBeVisible({ timeout: 15000 });
    });
    await step("Expand the row and click Open on the card → Files tab previews it", async () => {
      const toggle = page.getByTestId("tool-call-toggle").first();
      if (await toggle.isVisible().catch(() => false)) {
        await toggle.click();
      } else {
        await page.getByTestId("worklog-row").first().click();
      }
      await page.locator('[data-testid^="artifact-open-"]').first().click();
      await expect(page.getByTestId("artifacts-panel")).toBeVisible();
      await expect(page.getByTestId("artifact-viewer")).toContainText("E2E agent demo", { timeout: 15000 });
    });
  });
});
