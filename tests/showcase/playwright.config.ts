import { defineConfig, devices } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { FAKE_MIC_WAV, loadConfig, runDir } from "../e2e/support/config";

/**
 * Showcase recordings for the README and the Mintlify docs.
 *
 * Same isolated instance as the E2E journeys (global setup boots a fresh
 * Amiro and, when Docker and the images are there, the agent sandbox), but
 * every scene is a real task done with the real model from
 * tests/e2e.config.json — research on the live web, a real MCP server, the
 * agent's real desktop — with captions written for a reader, not a reviewer.
 *
 *   pnpm --dir tests showcase                 # record every scene
 *   pnpm --dir tests showcase --project research
 *   node tests/showcase/export-media.mjs      # webm → docs/assets/showcase/*.{mp4,gif}
 *
 * Scenes run in file order; `setup` (first run + model) comes first because
 * every other scene needs a connected provider.
 */
// The videos show a person, not a test fixture: same keys as
// tests/e2e.config.json, with a real-looking owner and agent look.
if (!process.env.AMIRO_E2E_CONFIG) {
  const testsDir = path.join(__dirname, "..");
  const read = (f: string) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {});
  const base = read(path.join(testsDir, "e2e.config.json"));
  const merged = {
    ...base,
    owner: { ...base.owner, name: "Priya", email: "priya@home.lan", timezone: "Asia/Kolkata" },
    agent: { ...base.agent, look: "Sprout", colour: "orange" },
    recording: { ...base.recording, slowMoMs: 120 },
  };
  const file = path.join(testsDir, ".e2e-state", "showcase.config.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(merged, null, 2), { mode: 0o600 });
  process.env.AMIRO_E2E_CONFIG = file;
}
// Nothing from the real home (other tools' sign-ins, quotas) may show on video.
process.env.AMIRO_E2E_ISOLATE_HOME ??= "1";
const cfg = loadConfig();
// Recordings land in tests/recordings/showcase-<stamp>/ (gitignored).
process.env.AMIRO_E2E_RUN_DIR ??= path.join(
  __dirname,
  "..",
  "recordings",
  `showcase-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`,
);
const dir = runDir();

const SCENES = [
  "research",
  "documents",
  "visualize",
  "schedules",
  "connectors",
  "desktop",
  "team",
  "agent-home",
  "admin",
  "devices",
] as const;

export default defineConfig({
  testDir: "./specs",
  outputDir: path.join(dir, "test-results"),
  globalSetup: "../e2e/support/global-setup.ts",
  globalTeardown: "../e2e/support/global-teardown.ts",
  timeout: 15 * 60 * 1000,
  expect: { timeout: 30000 },
  fullyParallel: false,
  workers: 1,
  // One retry: a provider rate limit (429) mid-scene should not cost the video.
  retries: 1,
  reporter: [["list"], ["json", { outputFile: path.join(dir, "results.json") }]],
  use: {
    ...devices["Desktop Chrome"],
    viewport: cfg.recording.viewport,
    headless: cfg.recording.headless,
    video: { mode: "on", size: cfg.recording.viewport },
    actionTimeout: 30000,
    navigationTimeout: 45000,
    permissions: ["microphone", "clipboard-read", "clipboard-write"],
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
    { name: "setup", testMatch: /00-setup\.spec\.ts/ },
    ...SCENES.map((name, i) => ({
      name,
      testMatch: new RegExp(`${String(i + 1).padStart(2, "0")}-${name}\\.spec\\.ts`),
      dependencies: ["setup"],
    })),
  ],
});
