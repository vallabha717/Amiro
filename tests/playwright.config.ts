import { defineConfig, devices } from "@playwright/test";
import * as path from "node:path";
import { FAKE_MIC_WAV, loadConfig, runDir } from "./e2e/support/config";

const cfg = loadConfig();
const dir = runDir();

/**
 * One Playwright project per journey. Every journey depends on `provider`
 * (which depends on `onboarding`), so `--project connectors` on its own still
 * gets a freshly onboarded instance with a working model.
 *
 * Add a new journey: put `NN-name.spec.ts` in e2e/specs, add it to JOURNEYS,
 * and follow tests/e2e/README.md (also .agents/skills/e2e-journeys/SKILL.md).
 */
const JOURNEYS = [
  "voice",
  "chat",
  "connectors",
  "credentials",
  "agent-hub",
  "agent-driven",
  "voice-live",
  "schedules",
  "ux-audit",
  "team",
  "notifications",
] as const;

const use = {
  ...devices["Desktop Chrome"],
  viewport: cfg.recording.viewport,
  headless: cfg.recording.headless,
  video: { mode: cfg.recording.video, size: cfg.recording.viewport },
  trace: "retain-on-failure" as const,
  screenshot: "on" as const,
  actionTimeout: 20000,
  navigationTimeout: 45000,
  // Fake mic so voice journeys run headless (Chrome plays .e2e-state/fake-mic.wav).
  permissions: ["microphone", "clipboard-read", "clipboard-write"],
};

export default defineConfig({
  testDir: "./e2e/specs",
  outputDir: path.join(dir, "test-results"),
  globalSetup: "./e2e/support/global-setup.ts",
  globalTeardown: "./e2e/support/global-teardown.ts",
  timeout: cfg.timeouts.testMs,
  expect: { timeout: 20000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: [
    ["list"],
    ["json", { outputFile: path.join(dir, "results.json") }],
    ["html", { outputFolder: path.join(dir, "html"), open: "never" }],
    ["./e2e/support/review-reporter.ts", { runDir: dir, stitch: cfg.recording.stitch }],
  ],
  use: {
    ...use,
    launchOptions: {
      slowMo: cfg.recording.slowMoMs,
      args: [
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        `--use-file-for-fake-audio-capture=${FAKE_MIC_WAV}`,
        "--autoplay-policy=no-user-gesture-required",
      ],
    },
  },
  projects: [
    { name: "onboarding", testMatch: /01-onboarding\.spec\.ts/ },
    { name: "provider", testMatch: /02-provider\.spec\.ts/, dependencies: ["onboarding"] },
    ...JOURNEYS.map((name, i) => ({
      name,
      testMatch: new RegExp(`${String(i + 3).padStart(2, "0")}-${name}\\.spec\\.ts`),
      dependencies: ["provider"],
    })),
  ],
});
