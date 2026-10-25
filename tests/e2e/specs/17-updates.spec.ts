/**
 * Journey 17 — updates: Admin → General → Version & updates.
 *
 * Offline: the release check answers from tests/e2e/fixtures/release-stub-server.mjs
 * (latest is v99.0.0) and the server's updater is
 * tests/e2e/fixtures/fake-amiro-update.sh, which prints installer output and
 * fails at the checksum, so a real update job runs without installing anything
 * (global-setup sets AMIRO_UPDATE_API_BASE / AMIRO_UPDATE_COMMAND).
 */
import { expect, test } from "../support/fixtures";

const LATEST = "v99.0.0";

test.describe("updates", () => {
  test("updates: the server shows the new release and its notes, runs the update, and reports a failure with the installer output", async ({
    page,
    step,
    amiro,
  }) => {
    const card = page.getByTestId("general-version");

    await step("Admin → General → Version & updates: current version, latest v99.0.0, Update available", async () => {
      await page.goto("/admin/general");
      await expect(card).toBeVisible();
      await expect(card.getByTestId("general-version-value")).toHaveText(/^v\d+\.\d+\.\d+/);
      await expect(card.getByTestId("update-available-badge")).toHaveText(`Update available: ${LATEST}`);
      await expect(card.getByTestId("general-version-latest")).toContainText(LATEST);
    });

    await step("What's new in v99.0.0 opens the release notes", async () => {
      await card.getByTestId("update-notes").locator("summary").click();
      await expect(card.getByTestId("update-notes")).toContainText("Self-update for the server and the desktop app");
    });

    await step("Update to v99.0.0 → the job runs: Downloading and installing…", async () => {
      await card.getByTestId("update-server-now").click();
      await expect(card.getByTestId("update-job")).toHaveAttribute("data-state", "installing");
      await expect(card.getByTestId("update-job")).toContainText(`Downloading and installing ${LATEST}`);
    });

    await step("The installer fails at the checksum → the card says so, with its output, and offers Try again", async () => {
      const job = card.getByTestId("update-job");
      await expect(job).toHaveAttribute("data-state", "failed", { timeout: 30000 });
      await expect(job).toContainText(`The update to ${LATEST} failed`);
      await expect(job).toContainText("exit code 1");
      await job.getByText("Installer output").click();
      await expect(card.getByTestId("update-job-log")).toContainText("checksum mismatch");
      // Colour codes from the installer are stripped.
      await expect(card.getByTestId("update-job-log")).not.toContainText("\u001b[");
      await expect(card.getByTestId("update-server-now")).toHaveText("Try again");
      const { body } = await amiro.api<{ job: { state: string; target: string } }>("/api/system/update/job");
      expect(body.job).toMatchObject({ state: "failed", target: LATEST });
    });

    await step("The failed job is still there after a reload (it is saved on the server)", async () => {
      await page.reload();
      await expect(card.getByTestId("update-job")).toHaveAttribute("data-state", "failed");
    });

    await step("Automatic updates: turn on Install server updates automatically → saved; turn it off again", async () => {
      const autoInstall = card.getByTestId("update-auto-install");
      await expect(card.getByTestId("update-auto-check")).toBeChecked();
      await expect(autoInstall).not.toBeChecked();
      await autoInstall.click();
      await expect(autoInstall).toBeChecked();
      let saved = await amiro.api<{ settings: { autoInstall: boolean } }>("/api/system/update");
      expect(saved.body.settings.autoInstall).toBe(true);
      await autoInstall.click();
      await expect(autoInstall).not.toBeChecked();
      saved = await amiro.api<{ settings: { autoInstall: boolean } }>("/api/system/update");
      expect(saved.body.settings.autoInstall).toBe(false);
    });
  });

  test("updates: an open tab or phone offers a reload once the server runs a new version", async ({ page, step }) => {
    await step("The server now answers as v99.0.0 → a banner offers to reload the screens", async () => {
      // Stand in for "the server was updated while this tab was open".
      await page.route("**/health", (route) =>
        route.fulfill({ json: { status: "ok", version: "99.0.0" } }),
      );
      await page.goto("/");
      const banner = page.getByTestId("update-reload-banner");
      await expect(banner).toBeVisible({ timeout: 20000 });
      await expect(banner).toContainText(`Amiro was updated to ${LATEST}`);
      await expect(page.getByTestId("update-reload-button")).toBeVisible();
    });

    await step("Dismiss hides it for this version", async () => {
      await page.getByRole("button", { name: "Dismiss" }).click();
      await expect(page.getByTestId("update-reload-banner")).toHaveCount(0);
    });
  });

  test("updates: the desktop app checks, downloads with progress and reports a failed install (stub shell)", async ({
    page,
    step,
  }) => {
    // The real shell is clients/desktop (tauri-plugin-updater); this stands in
    // for it with the same commands and progress events.
    await page.addInitScript(() => {
      const listeners: Record<string, (e: { payload: unknown }) => void> = {};
      const w = window as unknown as Record<string, unknown>;
      w.__AMIRO_DESKTOP__ = true;
      w.__TAURI__ = {
        core: {
          invoke: async (cmd: string) => {
            if (cmd === "desktop_update_check") {
              return { current: "1.27.0", available: true, version: "1.28.0", notes: "Signed desktop updates", supported: true };
            }
            if (cmd === "desktop_update_install") {
              const emit = (payload: unknown) => listeners["amiro://update-progress"]?.({ payload });
              for (const received of [0, 40, 80, 120]) {
                emit({ phase: "downloading", received, total: 160 });
                await new Promise((r) => setTimeout(r, 400));
              }
              throw new Error("signature verification failed");
            }
            return null;
          },
        },
        event: {
          listen: async (event: string, handler: (e: { payload: unknown }) => void) => {
            listeners[event] = handler;
            return () => delete listeners[event];
          },
        },
      };
    });
    const section = page.getByTestId("update-desktop");

    await step("In the desktop app, General shows a Desktop app row: 1.28.0 is available", async () => {
      await page.goto("/admin/general");
      await expect(section).toBeVisible();
      await expect(section).toContainText("Desktop v1.28.0 is available.");
      await expect(page.getByTestId("update-server-desktop").or(page.getByTestId("update-server"))).toBeVisible();
    });

    await step("Download and install → a progress bar fills as it downloads", async () => {
      await section.getByTestId("update-desktop-install").click();
      await expect(section.getByTestId("update-desktop-progress")).toBeVisible();
      await expect(section.getByRole("progressbar")).toHaveAttribute("aria-valuenow", /^(25|50|75)$/);
    });

    await step("A bad signature stops the install and says why; the app stays on its version", async () => {
      await expect(section.getByRole("alert")).toContainText("signature verification failed", { timeout: 10000 });
      await expect(section.getByTestId("update-desktop-install")).toBeVisible();
    });
  });
});
