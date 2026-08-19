import { defineConfig, devices } from "@playwright/test";
import * as path from "node:path";
import { resolveRun } from "./ui/support/resolve-run";

const run = resolveRun();

export default defineConfig({
  testDir: "./ui/specs",
  outputDir: path.join(run.dir, "ui/test-results"),
  reporter: [
    ["list"],
    ["json", { outputFile: path.join(run.dir, "ui/results.json") }],
    ["html", { outputFolder: path.join(run.dir, "ui/html"), open: "never" }],
    [path.resolve(__dirname, "./ui/support/timeline-reporter.ts"), { runDir: run.dir }],
  ],
  use: {
    baseURL: run.baseUrl || "http://127.0.0.1:8080",
    trace: run.config.ui.trace || "on",
    video: run.config.ui.video || "retain-on-failure",
    screenshot: run.config.ui.screenshot || "only-on-failure",
    viewport: run.config.ui.viewport || { width: 1280, height: 720 },
    actionTimeout: 15000,
    navigationTimeout: 30000,
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 960 },
        headless: run.config.ui.headless !== false,
      },
    },
  ],
  workers: run.config.run.parallel || 1,
  retries: run.config.run.retries || 0,
  timeout: 60000,
  forbidOnly: !!process.env.CI,
});
