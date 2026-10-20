/**
 * Journey 5 — Connectors / MCP through the UI: every auth style against the
 * offline fixture server (tests/e2e/fixtures/mcp-http-server.mjs), a local
 * stdio command, then a real tool call from chat that the fixture logs.
 */
import * as path from "node:path";
import type { Page } from "@playwright/test";
import { ask, newChat, selectModel } from "../support/chat";
import { REPO_ROOT } from "../support/config";
import { expect, test } from "../support/fixtures";

type Call = { mode: string; name: string; args: Record<string, unknown> };

async function openAddCustom(page: Page) {
  await page.goto("/connectors");
  await page.getByRole("button", { name: "Add custom" }).click();
  const dialog = page.getByRole("dialog", { name: "Add a custom connector" });
  await expect(dialog).toBeVisible();
  return dialog;
}

function connectorCard(page: Page, name: string) {
  return page.locator("main").getByText(name, { exact: true }).first();
}

async function calls(mcpBase: string): Promise<Call[]> {
  return (await fetch(`${mcpBase}/__calls`)).json() as Promise<Call[]>;
}

test.describe("connectors", () => {
  test("add remote MCP servers: no auth, bearer token, API-key header", async ({ page, step, note, amiro }) => {
    const { mcp } = amiro.cfg;

    await step("Connectors page: empty state + 'Add custom'", async () => {
      await page.goto("/connectors");
      await expect(page.getByRole("heading", { name: "Connectors", level: 1 })).toBeVisible();
      await expect(page.getByText("Nothing connected yet")).toBeVisible();
    });

    await step("Connect is disabled until name and URL are filled", async () => {
      const d = await openAddCustom(page);
      await expect(d.getByRole("button", { name: "Connect" })).toBeDisabled();
      await d.getByRole("button", { name: "Cancel" }).click();
    });

    await step("Remote URL, no auth → e2e-open", async () => {
      const d = await openAddCustom(page);
      await d.getByLabel("Name").fill("e2e-open");
      await d.getByLabel("Server URL").fill(`${amiro.mcpBase}/open/mcp`);
      await d.getByRole("button", { name: "None" }).click();
      await d.getByRole("button", { name: "Connect" }).click();
      await expect(d).toBeHidden({ timeout: 30000 });
      await expect(connectorCard(page, "e2e-open")).toBeVisible();
    });

    await step("Remote URL, bearer token (stored in the vault, never shown) → e2e-bearer", async () => {
      const d = await openAddCustom(page);
      await d.getByLabel("Name").fill("e2e-bearer");
      await d.getByLabel("Server URL").fill(`${amiro.mcpBase}/bearer/mcp`);
      await d.getByRole("button", { name: "Bearer token" }).click();
      const secret = d.locator('input[type="password"]').first();
      await secret.fill(mcp.bearerToken);
      await d.getByRole("button", { name: "Connect" }).click();
      await expect(d).toBeHidden({ timeout: 30000 });
      await expect(connectorCard(page, "e2e-bearer")).toBeVisible();
      expect(await page.locator("body").innerText()).not.toContain(mcp.bearerToken);
    });

    await step(`Remote URL, API key in ${mcp.apiKeyHeader} header → e2e-apikey`, async () => {
      const d = await openAddCustom(page);
      await d.getByLabel("Name").fill("e2e-apikey");
      await d.getByLabel("Server URL").fill(`${amiro.mcpBase}/apikey/mcp`);
      await d.getByRole("button", { name: "API key header" }).click();
      const header = d.getByRole("textbox", { name: /header/i }).first();
      if (await header.isVisible().catch(() => false)) await header.fill(mcp.apiKeyHeader);
      await d.locator('input[type="password"]').first().fill(mcp.apiKey);
      await d.getByRole("button", { name: "Connect" }).click();
      await expect(d).toBeHidden({ timeout: 30000 });
      await expect(connectorCard(page, "e2e-apikey")).toBeVisible();
    });

    await step("All three connectors list their tools (echo, add, whoami)", async () => {
      await page.getByRole("button", { name: "Refresh" }).click();
      for (const n of ["e2e-open", "e2e-bearer", "e2e-apikey"]) {
        await expect.soft(connectorCard(page, n)).toBeVisible();
      }
      await expect.soft(page.locator("main").getByText(/3 tools|echo/).first(), "tool count or names visible").toBeVisible({ timeout: 30000 });
    });

    await step("Wrong bearer token → connector shows an error state (not silently 'connected')", async () => {
      const d = await openAddCustom(page);
      await d.getByLabel("Name").fill("e2e-badtoken");
      await d.getByLabel("Server URL").fill(`${amiro.mcpBase}/bearer/mcp`);
      await d.getByRole("button", { name: "Bearer token" }).click();
      await d.locator('input[type="password"]').first().fill("wrong-token");
      await d.getByRole("button", { name: "Connect" }).click();
      await page.waitForTimeout(3000);
      if (await d.isVisible().catch(() => false)) {
        const inDialog = await d.innerText();
        expect.soft(inDialog, "the dialog should explain the 401").toMatch(/401|unauthori[sz]ed|failed|error|could not|invalid/i);
        await d.getByRole("button", { name: "Cancel" }).click();
      } else {
        const row = page.locator("main div").filter({ has: page.getByRole("button", { name: "More for e2e-badtoken" }) }).last();
        await expect.poll(async () => (await row.innerText().catch(() => "")).includes("Checking"), { timeout: 45000 }).toBe(false);
        const state = (await row.innerText().catch(() => "")).replace(/\s+/g, " ");
        if (!/error|401|unauthori|failed/i.test(state)) note(`Connector with a wrong bearer token shows: "${state.slice(0, 160)}" (no auth error surfaced).`, "bug");
        expect.soft(state, "a wrong token should show an error on the connector card").toMatch(/error|401|unauthori[sz]ed|failed/i);
      }
    });
  });

  test("add a local command (stdio) MCP server", async ({ page, step }) => {
    await step("Local command → node tests/fixtures/mcp/server/server.mjs", async () => {
      const d = await openAddCustom(page);
      await d.getByLabel("Name").fill("e2e-local");
      await d.getByRole("button", { name: /Local command/ }).click();
      const cmd = d.getByRole("textbox").nth(1);
      await cmd.fill(`node ${path.join(REPO_ROOT, "tests/fixtures/mcp/server/server.mjs")}`);
      await d.getByRole("button", { name: "Connect" }).click();
      await expect(d).toBeHidden({ timeout: 30000 });
      await expect(connectorCard(page, "e2e-local")).toBeVisible();
    });
  });

  test("OAuth MCP server: sign in through the consent page", async ({ page, step, note, amiro }) => {
    await step("Add remote URL that requires OAuth → e2e-oauth", async () => {
      const d = await openAddCustom(page);
      await d.getByLabel("Name").fill("e2e-oauth");
      await d.getByLabel("Server URL").fill(`${amiro.mcpBase}/oauth/mcp`);
      await d.getByRole("button", { name: "None" }).click();
      await d.getByRole("button", { name: "Connect" }).click();
      await expect(d).toBeHidden({ timeout: 30000 });
      await expect(connectorCard(page, "e2e-oauth")).toBeVisible();
    });

    let signIn: import("@playwright/test").Locator | undefined;
    await step("The e2e-oauth card (or its ••• menu) offers a sign-in action", async () => {
      const row = page.locator("main div").filter({ has: page.getByRole("button", { name: "More for e2e-oauth" }) }).last();
      const direct = row.getByRole("button", { name: /sign in|authori[sz]e|log ?in|reconnect/i }).first();
      if (await direct.isVisible({ timeout: 5000 }).catch(() => false)) signIn = direct;
      else {
        await page.getByRole("button", { name: "More for e2e-oauth" }).click();
        const item = page.getByRole("menuitem", { name: /sign in|authori[sz]e|log ?in/i }).first();
        if (await item.isVisible({ timeout: 3000 }).catch(() => false)) signIn = item;
        else await page.keyboard.press("Escape");
      }
      const shown = (await row.innerText().catch(() => "")).replace(/\s+/g, " ");
      if (!signIn) note(`OAuth MCP server added from the UI has no sign-in action; the card says: "${shown.slice(0, 240)}"`, "bug");
      expect.soft(signIn, "Connectors UI should offer 'Sign in' for an OAuth MCP server instead of 'run amiro mcp login in a terminal'").toBeTruthy();
    });

    if (signIn) {
      await step("Sign in → fixture consent page → Approve", async () => {
        const popupP = page.context().waitForEvent("page", { timeout: 30000 });
        await signIn!.click();
        const popup = await popupP;
        await popup.waitForLoadState();
        await expect(popup.getByRole("button", { name: "Approve" })).toBeVisible();
        await popup.getByRole("button", { name: "Approve" }).click();
        await popup.waitForLoadState().catch(() => {});
      });

      await step("Connector becomes authorized and lists tools", async () => {
        await page.bringToFront();
        await expect(page.getByRole("button", { name: "More for e2e-oauth" }).locator("xpath=..").getByText(/Connected/)).toBeVisible({ timeout: 60000 });
      });
    }
  });

  test("use connector tools from chat; disable and remove a connector", async ({ page, step, amiro }) => {
    await fetch(`${amiro.mcpBase}/__reset`);
    await step("Ask the agent to call echo on the bearer connector", async () => {
      await newChat(page);
      await selectModel(page);
      const reply = await ask(page, "Use the e2e-bearer MCP connector's echo tool with message 'hello-from-e2e' and show me exactly what it returned.");
      expect.soft(reply).toContain("ECHO: hello-from-e2e");
    });
    await step("The fixture server logged the call with valid bearer auth", async () => {
      const log = await calls(amiro.mcpBase);
      expect(log.some((c) => c.mode === "bearer" && c.name === "echo")).toBe(true);
    });
    await step("Ask for a sum through the API-key connector", async () => {
      const reply = await ask(page, "Use the e2e-apikey connector's add tool to add 19 and 23. Reply with just the number.");
      expect.soft(reply).toContain("42");
      expect.soft((await calls(amiro.mcpBase)).some((c) => c.mode === "apikey" && c.name === "add")).toBe(true);
    });
    await step("Disable e2e-open from the Connectors page", async () => {
      await page.goto("/connectors");
      const row = page.locator("main").locator("li, [data-slot=card], article, div").filter({ hasText: "e2e-open" }).last();
      const toggle = row.getByRole("switch").first();
      if (await toggle.isVisible().catch(() => false)) {
        await toggle.click();
        await expect.soft(toggle).toHaveAttribute("aria-checked", "false");
      }
    });
    await step("Remove e2e-local", async () => {
      const row = page.locator("main").locator("li, [data-slot=card], article, div").filter({ hasText: "e2e-local" }).last();
      await row.hover();
      const remove = row.getByRole("button", { name: /remove|delete/i }).first();
      if (await remove.isVisible().catch(() => false)) {
        await remove.click();
        const confirm = page.getByRole("alertdialog").or(page.getByRole("dialog")).getByRole("button", { name: /remove|delete|confirm/i });
        if (await confirm.isVisible().catch(() => false)) await confirm.click();
        await expect.soft(connectorCard(page, "e2e-local")).toBeHidden({ timeout: 15000 });
      }
    });
  });
});
