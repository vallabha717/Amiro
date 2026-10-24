/**
 * Focused E2E test for:
 * 1) Admin → Debug showing ONLY the per-agent Terminal (Host PTY for Amiro,
 *    isolated Container PTY for team agents).
 * 2) Vellum-style TV Screen (`AssistantDesktopAffordance` Monitor icon in the
 *    header -> floating 16:9 draggable/resizable `#assistant-desktop-preview`
 *    TV window -> expandable fullscreen `#assistant-desktop-modal` with
 *    Browser, File System, and Terminal).
 */
import { expect, test } from "../support/fixtures";

interface TeamAgent {
  id: string;
  name: string;
  isMain: boolean;
  workspaceDir: string;
}

test.describe.serial("debug-terminal-and-tv-screen", () => {
  test("admin debug has only Terminal, and header Monitor button opens Vellum TV screen per agent", async ({
    page,
    step,
    amiro,
  }) => {
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

    await step("Open Admin → Debug for Amiro (Main Agent) → ONLY Terminal is shown", async () => {
      await page.goto("/amiro/admin/debug");
      await expect(page.getByTestId("admin-debug-page")).toBeVisible();
      await expect(page.getByTestId("admin-sidebar-link-debug")).toBeVisible();
      await expect(page.getByTestId("terminal-panel")).toBeVisible();
      // Verify extra tabs are removed from Admin -> Debug
      await expect(page.getByTestId("admin-debug-tabs")).toHaveCount(0);
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

    await step("Select team agent Scout in Admin → Debug → verify container policy & connect Container PTY", async () => {
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

      // Auto-reconnect (or manual connect if still in error/idle) connects Scout's isolated Container PTY terminal
      const connectBtn = page.getByTestId("terminal-connect-button");
      if (await connectBtn.isVisible().catch(() => false)) {
        await connectBtn.click();
      }
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

    await step("Open chat header TV Screen (Monitor button) → connects live noVNC X11 Desktop (Xtigervnc + Openbox + Plank + Chromium)", async () => {
      await page.goto("/amiro");
      await expect(
        page.getByTestId("assistant-desktop-affordance"),
      ).toBeVisible();

      // Click the TV Monitor icon in the header -> floating 16:9 TV screen appears
      await page.getByTestId("assistant-desktop-affordance").click();
      const preview = page.getByTestId("assistant-desktop-preview");
      await expect(preview).toBeVisible();
      await expect(page.getByTestId("desktop-panel-viewport")).toBeVisible();

      // Wait for real noVNC RFB canvas to connect (desktop-panel-status disappears once connected)
      await expect(page.getByTestId("desktop-panel-status")).toHaveCount(0, {
        timeout: 30000,
      });
      await expect(
        page.getByTestId("desktop-panel-viewport").locator("canvas"),
      ).toBeVisible({ timeout: 15000 });

      // Expand the floating TV screen into the fullscreen Desktop modal (keeps same live VNC canvas!)
      await page.getByTestId("desktop-preview-title-button").click();
      const modal = page.getByTestId("assistant-desktop-modal");
      await expect(modal).toBeVisible();
      await expect(
        modal.getByTestId("desktop-panel-viewport").locator("canvas"),
      ).toBeVisible();

      // Minimize back to the floating TV window, then close
      await page.getByTestId("desktop-modal-minimize").click();
      await expect(page.getByTestId("assistant-desktop-modal")).toBeHidden();
      await expect(
        page.getByTestId("assistant-desktop-preview"),
      ).toBeVisible();

      await page.getByTestId("desktop-preview-close").click();
      await expect(page.getByTestId("assistant-desktop-preview")).toHaveCount(
        0,
      );
    });
  });
});
