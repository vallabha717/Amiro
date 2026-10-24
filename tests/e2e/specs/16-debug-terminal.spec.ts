/**
 * Focused E2E test for:
 * 1) Admin → Debug showing ONLY the per-agent Terminal (Host PTY for Amiro,
 *    isolated Container PTY for team agents).
 * 2) Vellum-style TV Screen (`AssistantDesktopAffordance` Monitor icon in the
 *    header -> floating 16:9 draggable/resizable `#assistant-desktop-preview`
 *    TV window -> expandable fullscreen `#assistant-desktop-modal`) streaming
 *    the agent's real X11 desktop from its sandbox container: Chromium, Files
 *    (Thunar) and a terminal, clickable through noVNC. Without a sandbox the
 *    TV says the desktop isn't running.
 */
import { execFileSync } from "node:child_process";
import { ask, newChat, selectModel } from "../support/chat";
import { readInstance } from "../support/config";
import { expect, test } from "../support/fixtures";

/** Run a tmux command against the main agent's shared shell. */
function sharedShell(namespace: string, args: string[]): string {
  try {
    return execFileSync("docker", ["exec", `${namespace}-agent-main`, "tmux", ...args], {
      encoding: "utf8",
    });
  } catch {
    return "";
  }
}

/** Names of the programs running in the main agent's desktop container. */
function desktopProcesses(namespace: string): string[] {
  try {
    const out = execFileSync(
      "docker",
      ["exec", `${namespace}-agent-main`, "ps", "-eo", "comm="],
      { encoding: "utf8" },
    );
    return [...new Set(out.split("\n").map((l) => l.trim()).filter(Boolean))];
  } catch {
    return [];
  }
}

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

    const sandboxRun = readInstance().sandbox;

    await step(
      sandboxRun
        ? "Connect Amiro's terminal → with the sandbox it is the shared shell in Amiro's container → run a command, disconnect"
        : "Connect Amiro's Host PTY Terminal → run a command and disconnect",
      async () => {
      await page.getByTestId("terminal-connect-button").click();
      await expect(page.getByTestId("terminal-status-badge")).toHaveAttribute(
        "data-status",
        "connected",
        { timeout: 30000 },
      );
      await expect(page.getByTestId("terminal-isolation-badge")).toContainText(
        sandboxRun ? "Container PTY" : "Host PTY",
      );

      await page.getByTestId("terminal-console").click();
      await page.keyboard.type("echo AMIRO_TERMINAL_READY\r");
      await page.waitForTimeout(800);

      await page.getByTestId("terminal-disconnect-button").click();
      await expect(page.getByTestId("terminal-status-badge")).toHaveAttribute(
        "data-status",
        "closed",
      );
      },
    );

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
      // Turning Shell on makes the panel reconnect by itself. Clicking Connect
      // while that is in flight opens a second session that ends the first,
      // so give it a moment and click only if it did not connect.
      const status = page.getByTestId("terminal-status-badge");
      const autoConnected = await expect(status)
        .toHaveAttribute("data-status", "connected", { timeout: 10000 })
        .then(() => true, () => false);
      if (!autoConnected && (await connectBtn.isVisible().catch(() => false))) {
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

    const sandbox = readInstance().sandbox;

    await step(
      sandbox
        ? "TV screen: open it from the chat header → it streams Amiro's real desktop (Chromium open, Files and Terminal in the dock)"
        : "TV screen: open it from the chat header with no sandbox → it says the desktop isn't running, no fake desktop",
      async () => {
        await page.goto("/amiro");
        await expect(page.getByTestId("assistant-desktop-affordance")).toBeVisible();
        await page.getByTestId("assistant-desktop-affordance").click();
        await expect(page.getByTestId("assistant-desktop-preview")).toBeVisible();
        await expect(page.getByTestId("desktop-panel-viewport")).toBeVisible();

        if (!sandbox) {
          await expect(page.getByTestId("desktop-panel-status")).toHaveAttribute(
            "data-state",
            "unavailable",
            { timeout: 30000 },
          );
          await expect(page.getByTestId("desktop-panel-reconnect")).toBeVisible();
          return;
        }

        // The stream connects (status overlay gone) and noVNC draws the frame buffer.
        await expect(page.getByTestId("desktop-panel-status")).toHaveCount(0, {
          timeout: 45000,
        });
        await expect(
          page.getByTestId("desktop-panel-viewport").locator("canvas"),
        ).toBeVisible({ timeout: 15000 });
        // Those pixels come from real programs in Amiro's container.
        await expect
          .poll(() => desktopProcesses(sandbox.namespace), { timeout: 20000 })
          .toEqual(expect.arrayContaining(["Xtigervnc", "openbox", "plank", "chromium"]));
        // The TV names what is in front: Chromium at its exact address.
        const bar = page.getByTestId("assistant-desktop-preview").getByTestId("desktop-window-bar");
        await expect(bar.getByTestId("desktop-window-location")).toContainText("https://example.com", {
          timeout: 20000,
        });
        await page.waitForTimeout(2500);
      },
    );

    await step("TV screen: expand to fullscreen → click Files, then Terminal in the dock → both open on the live desktop", async () => {
      if (!sandbox) return;
      await page.getByTestId("desktop-preview-title-button").click();
      const modal = page.getByTestId("assistant-desktop-modal");
      await expect(modal).toBeVisible();
      const canvas = modal.getByTestId("desktop-panel-viewport").locator("canvas");
      await expect(canvas).toBeVisible();

      // Plank's dock sits bottom-centre of the 1440x810 desktop: Chrome, Files, Terminal.
      const box = (await canvas.boundingBox())!;
      const at = (x: number, y: number) => ({
        x: box.x + (x / 1440) * box.width,
        y: box.y + (y / 810) * box.height,
      });
      const files = at(720, 784);
      await page.mouse.click(files.x, files.y);
      await expect
        .poll(() => desktopProcesses(sandbox!.namespace), { timeout: 20000 })
        .toContain("thunar");
      // The header shows the exact folder Files has open, where it is on this computer:
      // Amiro's workspace, named for Amiro.
      const bar = modal.getByTestId("desktop-window-bar");
      await expect(bar.locator('[data-app="files"]').first()).toContainText(`${sandbox!.home}/workspace`, { timeout: 15000 });
      await page.waitForTimeout(2000);
      const terminal = at(778, 784);
      await page.mouse.click(terminal.x, terminal.y);
      await expect
        .poll(() => desktopProcesses(sandbox!.namespace), { timeout: 20000 })
        .toContain("xfce4-terminal");
      await expect(bar.locator('[data-app="terminal"]').first()).toContainText(`${sandbox!.home}/workspace`, { timeout: 15000 });
      await page.waitForTimeout(2500);
    });

    await step("TV screen: minimize back to the floating TV, then close it", async () => {
      if (!sandbox) {
        await page.getByTestId("desktop-preview-close").click();
        await expect(page.getByTestId("assistant-desktop-preview")).toHaveCount(0);
        return;
      }
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

    await step("Debug terminal and the TV's terminal are one shell: type in Debug → it shows on the TV, prompt names Amiro and its real workspace", async () => {
      if (!sandbox) return;
      await page.goto("/amiro/admin/debug");
      await page.getByTestId("terminal-connect-button").click();
      await expect(page.getByTestId("terminal-isolation-badge")).toContainText("Container PTY", {
        timeout: 30000,
      });
      await page.getByTestId("terminal-console").click();
      await page.keyboard.type("echo SYNCED_WITH_TV\r");
      // Debug and the TV's terminal window are both attached to the shared tmux session.
      await expect
        .poll(() => sharedShell(sandbox.namespace, ["list-clients", "-t", "agent"]).split("\n").filter(Boolean).length, {
          timeout: 15000,
        })
        .toBeGreaterThanOrEqual(2);
      await expect
        .poll(() => sharedShell(sandbox.namespace, ["capture-pane", "-p", "-J", "-t", "agent"]), { timeout: 15000 })
        .toContain("SYNCED_WITH_TV");
      // The prompt reads like a shell on this computer: amiro@amiro-os:<Amiro's workspace>$
      expect(sharedShell(sandbox.namespace, ["capture-pane", "-p", "-J", "-t", "agent"])).toContain(
        `amiro@amiro-os:${sandbox.home}/workspace`,
      );
      // Show it on the TV too (the Monitor button is in the chat header).
      await page.goto("/amiro");
      await page.getByTestId("assistant-desktop-affordance").click();
      await page.getByTestId("desktop-preview-title-button").click();
      await expect(
        page.getByTestId("assistant-desktop-modal").getByTestId("desktop-panel-viewport").locator("canvas"),
      ).toBeVisible({ timeout: 30000 });
      await page.waitForTimeout(3000);
      await page.getByTestId("desktop-modal-close").click();
    });
  });

  test("TV in chat: the agent opens Files on its desktop and the chat shows the live TV with the exact folder", async ({
    page,
    step,
  }) => {
    const sandbox = readInstance().sandbox;
    test.skip(!sandbox, "needs the run's sandbox (Docker + amiro-agent:local)");
    const folder = "/home/agent/projects/tv-demo";
    // The same folder where it really is: Amiro's workspace on this computer.
    const onComputer = `${sandbox!.home}/workspace/projects/tv-demo`;
    execFileSync("docker", ["exec", `${sandbox!.namespace}-agent-main`, "mkdir", "-p", folder]);

    await step("Ask Amiro to open the folder on its desktop → it calls desktop_open", async () => {
      await newChat(page);
      await selectModel(page);
      await ask(
        page,
        `Use your desktop_open tool to open Files at ${folder} on your desktop, then tell me which folder is open.`,
        { timeoutMs: 120000 },
      );
    });

    await step("The chat shows the TV card: live desktop and Files at the exact folder", async () => {
      const card = page.getByTestId("desktop-chat-card").last();
      await expect(card).toBeVisible({ timeout: 30000 });
      await expect(card.getByTestId("desktop-chat-card-screen").locator("canvas")).toBeVisible({ timeout: 45000 });
      // Files at the exact folder, listed first because it is in front.
      const rows = card.getByTestId("desktop-window-row");
      await expect(rows.filter({ hasText: onComputer }).first()).toHaveAttribute("data-app", "files");
      await expect(rows.first()).toContainText(onComputer);
      await page.waitForTimeout(2500);
    });

    await step("Full screen from the card → the TV header names the same folder", async () => {
      await page.getByTestId("desktop-chat-card").last().getByTestId("desktop-chat-card-fullscreen").click();
      const modal = page.getByTestId("assistant-desktop-modal");
      await expect(modal).toBeVisible();
      await expect(modal.getByTestId("desktop-panel-viewport").locator("canvas")).toBeVisible({ timeout: 45000 });
      await expect(modal.getByTestId("desktop-window-bar")).toContainText(onComputer, { timeout: 15000 });
      await page.waitForTimeout(2500);
      await page.getByTestId("desktop-modal-close").click();
      await expect(modal).toBeHidden();
    });
  });
});
