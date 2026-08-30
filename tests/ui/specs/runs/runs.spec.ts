import { test, expect } from "../../support/fixtures";
import { RunsPage } from "../../pages";

// The "Agent runs" panel (docs/coding-agent-parity/
// 05-background-agent-runs.md): starting a run from the web returns
// immediately with a "running" row, and the run keeps going after this
// tab navigates away -- the whole point of a background job.
test.describe("agent runs panel", () => {
  test("starts a run and shows it as running in the list", async ({
    signedIn,
  }) => {
    const runs = new RunsPage(signedIn);
    await runs.goto();

    await expect(runs.panel).toBeVisible({ timeout: 15000 });

    await runs.promptInput.fill(
      "background run e2e check -- say hello and stop",
    );
    await runs.startButton.click();

    const row = runs.rows.first();
    await expect(row).toBeVisible({ timeout: 15000 });
    await expect(runs.statusBadgeFor(row)).toHaveText(
      /running|suspended|done/i,
      { timeout: 15000 },
    );

    // The row survives a reload -- it is a real, persisted job, not
    // client-side UI state that would vanish with the tab.
    await runs.page.reload();
    await runs.goto();
    await expect(runs.rows.first()).toBeVisible({ timeout: 15000 });
  });
});
