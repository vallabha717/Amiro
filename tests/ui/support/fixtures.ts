import { test as base, type Page } from "@playwright/test";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveRun } from "./resolve-run";

const run = resolveRun();

export interface AccountInfo {
  id: string;
  name: string;
  email: string;
  password: string;
  token: string;
  role: string;
}

export interface AmiroBackendInfo {
  baseUrl: string;
  port: number;
  token: string;
  pid: number;
  testId: string;
  appDataDir: string;
  home: string;
  workspace: string;
  runDir: string;
  runId: string;
  accounts: {
    admin: AccountInfo;
    user: AccountInfo;
    other: AccountInfo;
  };
}

export interface AmiroFixtures {
  amiro: AmiroBackendInfo;
  signedIn: Page;
  admin: Page;
}

export const test = base.extend<AmiroFixtures>({
  amiro: async ({}, use, testInfo) => {
    const testsDir = path.resolve(__dirname, "../..");
    const testSlug = testInfo.titlePath.join("-").replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase();
    const testId = `ui-${testSlug.slice(0, 40)}-${Date.now().toString(36)}`;

    // Shell out to amirotest backend start --json
    let info: AmiroBackendInfo;
    try {
      const output = execSync(
        `go run ./cmd/amirotest backend start --json --test-id ${testId} --surface ui`,
        {
          cwd: testsDir,
          encoding: "utf-8",
          env: { ...process.env },
        }
      );
      info = JSON.parse(output.trim());
    } catch (err: any) {
      throw new Error(`Failed to start backend for test ${testId}: ${err.message}\nOutput: ${err.stdout || ""}`);
    }

    try {
      await use(info);
    } finally {
      // Teardown backend
      try {
        execSync(`go run ./cmd/amirotest backend stop --pid ${info.pid} --run-dir ${info.runDir}`, {
          cwd: testsDir,
          encoding: "utf-8",
          env: { ...process.env },
        });
      } catch {
        // ignore stop errors
      }
    }
  },

  // A custom context fixture is required because each test's `amiro`
  // fixture starts its own backend on its own port, so baseURL can only be
  // known per test -- the global playwright.config.ts baseURL is only a
  // fallback for tooling that never resolves a run. That means Playwright's
  // own video/trace/screenshot wiring, which lives inside the *default*
  // context fixture, has to be reproduced here by hand; trace and
  // screenshot survive a custom context fixture (Playwright hooks those at
  // the browser level), but video does not -- recordVideo must be part of
  // the newContext() call itself, so skipping it here silently produced 0
  // videos even for failing tests (see verification-log-phase-05.md,
  // Criterion 2).
  context: async ({ browser, amiro }, use, testInfo) => {
    const videoMode = run.config.ui.video || "retain-on-failure";
    const context = await browser.newContext({
      baseURL: amiro.baseUrl,
      viewport: run.config.ui.viewport,
      recordVideo: videoMode === "off" ? undefined : { dir: testInfo.outputDir, size: run.config.ui.viewport },
    });
    await use(context);

    // Grab the handle before closing -- video.path() only resolves once
    // the context that owns it has closed and flushed the file, and it has
    // to be read from the still-open context's page list first.
    const video = context.pages()[0]?.video();
    await context.close();

    if (!video) return;
    const keep =
      videoMode === "on" ||
      (videoMode === "retain-on-failure" && testInfo.status !== testInfo.expectedStatus) ||
      (videoMode === "on-first-retry" && testInfo.retry > 0 && testInfo.status !== testInfo.expectedStatus);

    if (keep) {
      const videoPath = await video.path();
      testInfo.attachments.push({ name: "video", path: videoPath, contentType: "video/webm" });
    } else {
      await video.delete().catch(() => {});
    }
  },

  page: async ({ context, amiro }, use, testInfo) => {
    const page = await context.newPage();
    const runDir = amiro?.runDir || process.env.AMIRO_TEST_RUN_DIR || path.resolve(__dirname, "../../logs/latest");
    const testDir = path.join(runDir, "ui", amiro?.testId || "test");
    fs.mkdirSync(testDir, { recursive: true });

    const consolePath = path.join(testDir, "console.ndjson");
    const pageErrorsPath = path.join(testDir, "pageerrors.ndjson");
    const uncaughtErrors: string[] = [];

    // Capture browser console logs
    page.on("console", (msg) => {
      const entry = {
        ts: new Date().toISOString(),
        type: msg.type(),
        text: msg.text(),
        location: msg.location(),
      };
      try {
        fs.appendFileSync(consolePath, JSON.stringify(entry) + "\n", "utf-8");
      } catch {}
    });

    // Capture uncaught page errors
    page.on("pageerror", (err) => {
      uncaughtErrors.push(err.message || String(err));
      const entry = {
        ts: new Date().toISOString(),
        message: err.message,
        stack: err.stack,
      };
      try {
        fs.appendFileSync(pageErrorsPath, JSON.stringify(entry) + "\n", "utf-8");
      } catch {}
    });

    // Disable CSS animations globally to eliminate motion flakiness
    await page.addInitScript(() => {
      const style = document.createElement("style");
      style.innerHTML = `
        *, *::before, *::after {
          animation-duration: 0.001s !important;
          animation-delay: 0s !important;
          transition-duration: 0.001s !important;
          transition-delay: 0s !important;
        }
      `;
      document.head?.appendChild(style);
    });

    await page.emulateMedia({ reducedMotion: "reduce" });

    await use(page);

    // Assert no uncaught page errors unless test allows them
    const allowed = testInfo.annotations.some((a) => a.type === "allow-page-errors");
    if (!allowed && uncaughtErrors.length > 0) {
      throw new Error(`Test encountered ${uncaughtErrors.length} uncaught page error(s):\n${uncaughtErrors.join("\n")}`);
    }
  },

  signedIn: async ({ amiro, page }, use) => {
    const userToken = amiro.accounts?.user?.token;
    if (!userToken) {
      throw new Error("No user token available in amiro fixture");
    }

    await page.addInitScript((token) => {
      try {
        window.localStorage?.setItem("amiro.session-token", token);
      } catch {}
    }, userToken);

    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
    await use(page);
  },

  admin: async ({ amiro, page }, use) => {
    const adminToken = amiro.accounts?.admin?.token;
    if (!adminToken) {
      throw new Error("No admin token available in amiro fixture");
    }

    await page.addInitScript((token) => {
      try {
        window.localStorage?.setItem("amiro.session-token", token);
      } catch {}
    }, adminToken);

    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
    await use(page);
  },
});

export { expect } from "@playwright/test";
