/**
 * Focused E2E test for Admin → Debug (Terminal, Browser & Screen, File System)
 * across the main agent (Amiro) and an isolated team agent (Scout).
 */
import { expect, test } from "../support/fixtures";

interface TeamAgent {
  id: string;
  name: string;
  isMain: boolean;
  workspaceDir: string;
}

test.describe.serial("debug-terminal-browser-files", () => {
  test("admin debug: per-agent Terminal, Browser & Screen, and File System UI", async ({
    page,
    step,
    amiro,
  }) => {
    // Ensure a team agent "Scout" exists via the API
    const existing = await amiro.api<{ agents: TeamAgent[] }>("/api/agents");
    let scout = existing.body.agents.find((a) => a.name === "Scout");
    if (!scout) {
      const created = await amiro.api<TeamAgent>("/api/agents", {
        method: "POST",
        body: JSON.stringify({
          name: "Scout",
          role: "Research specialist",
          instructions: "Inspect sources in your isolated container.",
        }),
      });
      expect(created.status).toBe(201);
      scout = created.body;
    }

    await step("Open Admin → Debug for Amiro (Main Agent) → Terminal tab is shown", async () => {
      await page.goto("/amiro/admin/debug");
      await expect(page.getByTestId("admin-debug-page")).toBeVisible();
      await expect(page.getByTestId("admin-sidebar-link-debug")).toBeVisible();
      await expect(page.getByTestId("terminal-panel")).toBeVisible();
      await expect(page.getByTestId("terminal-status-badge")).toHaveAttribute(
        "data-status",
        "idle",
      );
    });

    await step("Connect Amiro's Host PTY Terminal → run a command and disconnect", async () => {
      await page.getByTestId("terminal-connect-button").click();
      await expect(page.getByTestId("terminal-status-badge")).toHaveAttribute(
        "data-status",
        "connected",
        { timeout: 15000 },
      );
      await expect(page.getByTestId("terminal-isolation-badge")).toContainText(
        "Host PTY",
      );

      await page.getByTestId("terminal-console").click();
      await page.keyboard.type("echo AMIRO_TERMINAL_READY\r");
      await page.waitForTimeout(800);

      await page.getByTestId("terminal-disconnect-button").click();
      await expect(page.getByTestId("terminal-status-badge")).toHaveAttribute(
        "data-status",
        "closed",
      );
    });

    await step("Switch to Browser & Screen tab → navigate and inspect live viewport", async () => {
      await page.getByTestId("admin-debug-tab-browser").click();
      await expect(page.getByTestId("agent-browser-panel")).toBeVisible();
      await page.getByTestId("agent-browser-url-input").fill("about:blank");
      await page.getByTestId("agent-browser-go-button").click();
      await expect(
        page.getByTestId("agent-browser-screen-image"),
      ).toBeVisible({ timeout: 15000 });
      await expect(page.getByTestId("agent-browser-page-title")).toHaveText(
        "Blank Page",
      );
    });

    await step("Switch to File System tab → browse Amiro's workspace files", async () => {
      await page.getByTestId("admin-debug-tab-files").click();
      await expect(page.getByTestId("workspace-browser")).toBeVisible();
    });

    await step("Select team agent Scout → verify container policy & enable Shell", async () => {
      await page.goto(`/${scout!.id}/admin/debug`);
      await expect(page.getByTestId("debug-team-agent-banner")).toBeVisible();

      // With Shell off initially, connecting shows the fail-closed error banner
      await page.getByTestId("terminal-connect-button").click();
      await expect(page.getByTestId("terminal-error-banner")).toContainText(
        "Shell access is disabled",
      );

      // Enable Shell switch for Scout right from the Debug banner
      await page.getByTestId("debug-team-shell-switch").click();
      await expect(page.getByTestId("debug-team-shell-switch")).toBeChecked();

      // Connect Scout's isolated Container PTY terminal
      await page.getByTestId("terminal-connect-button").click();
      await expect(page.getByTestId("terminal-status-badge")).toHaveAttribute(
        "data-status",
        "connected",
        { timeout: 25000 },
      );
      await expect(page.getByTestId("terminal-isolation-badge")).toContainText(
        "Container PTY",
      );

      await page.getByTestId("terminal-disconnect-button").click();
      await expect(page.getByTestId("terminal-status-badge")).toHaveAttribute(
        "data-status",
        "closed",
      );
    });

    await step("Scout's Browser & File System tabs operate in Scout's isolated scope", async () => {
      await page.getByTestId("admin-debug-tab-browser").click();
      await expect(page.getByTestId("agent-browser-panel")).toBeVisible();
      await page.getByTestId("agent-browser-url-input").fill("about:blank");
      await page.getByTestId("agent-browser-go-button").click();
      await expect(
        page.getByTestId("agent-browser-screen-image"),
      ).toBeVisible({ timeout: 15000 });

      await page.getByTestId("admin-debug-tab-files").click();
      await expect(page.getByTestId("workspace-browser")).toBeVisible();
    });
  });
});
