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
      await page.getByTestId("update-reload-banner").getByRole("button", { name: "Dismiss" }).click();
      await expect(page.getByTestId("update-reload-banner")).toHaveCount(0);
    });
  });

  test("updates: a phone app reloads itself with the new screens when you come back to it", async ({ page, step }) => {
    // A server run from a source checkout keeps its version and changes
    // commit with every update; the Home Screen app compares both.
    const NEW_COMMIT = "4b1d2c9";
    let serverCommit: string | null = null;
    await page.route("**/health", async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      route.fulfill({ json: serverCommit ? { ...body, commit: serverCommit } : body });
    });

    await step("Same release, new commit on the server → the banner names the build", async () => {
      await page.goto("/");
      const { version } = await page.evaluate(async () => (await fetch("/health")).json());
      serverCommit = NEW_COMMIT;
      await page.reload();
      const banner = page.getByTestId("update-reload-banner");
      await expect(banner).toBeVisible({ timeout: 20000 });
      await expect(banner).toContainText(`Amiro was updated to v${version} (${NEW_COMMIT})`);
    });

    await step("Something typed in the composer: coming back keeps the page and the text", async () => {
      const composer = page.locator("[contenteditable='true']").first();
      await composer.click();
      await page.keyboard.type("Draft for Brew & Bloom's opening post");
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      await page.waitForTimeout(1500);
      await expect(composer).toContainText("Draft for Brew & Bloom's opening post");
      await expect(page.getByTestId("update-reload-banner")).toBeVisible();
    });

    await step("Nothing typed: coming back to the app reloads it by itself", async () => {
      await page.locator("[contenteditable='true']").first().click();
      await page.keyboard.press("ControlOrMeta+a");
      await page.keyboard.press("Backspace");
      await page.evaluate(() => {
        (window as unknown as { __beforeReload?: boolean }).__beforeReload = true;
      });
      const reloaded = page.waitForEvent("load");
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      await reloaded;
      expect(await page.evaluate(() => (window as unknown as { __beforeReload?: boolean }).__beforeReload)).toBeUndefined();
    });
  });

  test("updates: a server run from a source checkout lists the new commits, rebuilds itself and comes back on the new commit", async ({
    page,
    step,
  }) => {
    // The test server is an install.sh-style build (fake updater), so the
    // checkout's API answers are stood in here; backend/tests/updates.rs runs
    // the real thing against a git checkout with a local origin.
    const RUNNING = "9ecb917";
    const LATEST = "4b1d2c9";
    let job: Record<string, unknown> = { state: "idle" };
    let current = RUNNING;
    let polls = 0;
    await page.route(/\/api\/system\/update(\?refresh=1)?$/, async (route) => {
      if (route.request().method() === "POST") {
        job = { state: "installing", kind: "source", branch: "main", from: RUNNING, target: LATEST, trigger: "manual" };
        return route.fulfill({ json: { started: true, version: LATEST, job } });
      }
      const res = await route.fetch();
      const real = await res.json();
      return route.fulfill({
        json: {
          ...real,
          method: "source",
          canSelfUpdate: true,
          updateAvailable: current !== LATEST,
          job,
          source: {
            branch: "main",
            running: current,
            latest: LATEST,
            behind: current === LATEST ? 0 : 2,
            commits:
              current === LATEST
                ? []
                : [
                    { sha: LATEST, subject: "feat(schedules): agenda page with templates", date: "2026-11-02T14:40:00Z" },
                    { sha: "091e80b", subject: "fix(runtime): stream Antigravity thinking live", date: "2026-11-02T14:20:00Z" },
                  ],
            dirty: false,
            checkFailed: false,
            error: null,
            checkedAt: new Date().toISOString(),
          },
        },
      });
    });
    await page.route("**/api/system/update/job", (route) => {
      polls += 1;
      if (job.state === "installing" && polls > 2) job = { ...job, state: "restarting" };
      else if (job.state === "restarting" && polls > 4) {
        job = { ...job, state: "succeeded", finishedAt: new Date().toISOString() };
        current = LATEST;
      }
      return route.fulfill({ json: { current: "1.27.0", commit: current, job } });
    });
    const card = page.getByTestId("general-version");

    await step("Admin → General: the server follows main and is 2 changes behind", async () => {
      await page.goto("/admin/general");
      await expect(card.getByTestId("update-available-badge")).toHaveText("2 new changes on main");
      await expect(card.getByTestId("general-version-value")).toContainText(`(${RUNNING})`);
      await expect(card.getByTestId("general-version-latest")).toContainText(`${LATEST} on main`);
      await expect(card.getByTestId("update-server-source")).toContainText("follows main on GitHub");
    });

    await step("What's new on main lists the commits", async () => {
      await card.getByTestId("update-notes").locator("summary").click();
      await expect(card.getByTestId("update-notes")).toContainText("feat(schedules): agenda page with templates");
      await expect(card.getByTestId("update-notes")).toContainText("091e80b");
    });

    await step("Update to the latest main → it pulls and builds, restarts, and reports the new commit", async () => {
      await expect(card.getByTestId("update-server-now")).toHaveText("Update to the latest main (2 changes)");
      await card.getByTestId("update-server-now").click();
      await expect(card.getByTestId("update-job")).toContainText(`Pulling and building ${LATEST}`);
      await expect(card.getByTestId("update-job")).toHaveAttribute("data-state", "restarting", { timeout: 15000 });
      await expect(card.getByTestId("update-job")).toHaveAttribute("data-state", "succeeded", { timeout: 15000 });
      await expect(card.getByTestId("update-job")).toContainText(`Updated to ${LATEST}.`);
    });

    await step("Automatic updates are available for a source checkout too", async () => {
      await expect(card.getByTestId("update-auto-install")).toBeEnabled();
      await expect(card.getByTestId("update-settings")).toContainText("Only while no chat or schedule is running");
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
