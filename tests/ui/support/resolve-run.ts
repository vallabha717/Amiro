import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export interface AccountConfig {
  email?: string;
  password?: string;
  name?: string;
}

export interface RunConfig {
  run: {
    id: string;
    surfaces: string[];
    features: string[];
    parallel: number;
    timeout: string;
    retries: number;
    failFast: boolean;
    keepArtifacts: string;
  };
  ui: {
    browsers: string[];
    headless: boolean;
    trace: "on" | "off" | "retain-on-failure" | "on-first-retry";
    video: "on" | "off" | "retain-on-failure" | "on-first-retry";
    screenshot: "on" | "off" | "only-on-failure";
    viewport: { width: number; height: number };
    mode: "embedded" | "external";
  };
  backend: {
    bindHost: string;
  };
  accounts: {
    admin: AccountConfig;
    user: AccountConfig;
    other: AccountConfig;
  };
}

export interface ResolvedRun {
  dir: string;
  id: string;
  manifestPath: string;
  config: RunConfig;
  baseUrl?: string;
}

export function resolveRun(): ResolvedRun {
  const testsDir = path.resolve(__dirname, "../..");

  let runDir: string = process.env.AMIRO_TEST_RUN_DIR || "";
  let runId: string = process.env.AMIRO_TEST_RUN_ID || "";

  if (!runDir) {
    // Shell out to amirotest env --surface ui --json to mint or join a run
    try {
      const output = execSync("go run ./cmd/amirotest env --surface ui --json", {
        cwd: testsDir,
        encoding: "utf-8",
        env: { ...process.env },
      });
      const data = JSON.parse(output.trim());
      runDir = data.runDir || "";
      runId = data.runId || "";
      if (data.env) {
        for (const [k, v] of Object.entries(data.env)) {
          process.env[k] = v as string;
        }
      }
    } catch (_err) {
      // Fallback: create a local logs directory if go run fails
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      runDir = path.join(testsDir, "logs", timestamp);
      runId = timestamp;
      fs.mkdirSync(runDir, { recursive: true });
      process.env.AMIRO_TEST_RUN_DIR = runDir;
      process.env.AMIRO_TEST_RUN_ID = runId;
    }
  }

  const manifestPath = path.join(runDir, "run.json");
  let cfg: Partial<RunConfig> = {};

  if (fs.existsSync(manifestPath)) {
    try {
      const raw = fs.readFileSync(manifestPath, "utf-8");
      const manifest = JSON.parse(raw);
      cfg = manifest.config || {};
    } catch {
      // ignore
    }
  }

  const defaults: RunConfig = {
    run: {
      id: runId || "unknown",
      surfaces: ["ui"],
      features: [],
      parallel: 1,
      timeout: "5m",
      retries: 0,
      failFast: false,
      keepArtifacts: "on-failure",
      ...(cfg.run || {}),
    },
    ui: {
      browsers: ["chromium"],
      headless: true,
      trace: "on",
      video: "retain-on-failure",
      screenshot: "only-on-failure",
      viewport: { width: 1280, height: 720 },
      mode: "embedded",
      ...(cfg.ui || {}),
    },
    backend: {
      bindHost: "127.0.0.1",
      ...(cfg.backend || {}),
    },
    accounts: {
      admin: { email: "admin@amiro.test", password: "Amiro-Test-Admin-1", ...(cfg.accounts?.admin || {}) },
      user: { email: "user@amiro.test", password: "Amiro-Test-User-1", ...(cfg.accounts?.user || {}) },
      other: { email: "other@amiro.test", password: "Amiro-Test-Other-1", ...(cfg.accounts?.other || {}) },
    },
  };

  return {
    dir: runDir,
    id: runId || path.basename(runDir),
    manifestPath,
    config: defaults,
  };
}
