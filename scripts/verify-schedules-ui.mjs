// End-to-end schedule checks against the real native backend and static UI.
// Run after `pnpm build` and `cargo build --manifest-path backend/Cargo.toml`.
// Every account, schedule, and run belongs to an isolated temporary AMIRO_HOME.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch =
  process.env.JCODE_SCRATCH_DIR || path.join(ROOT, "backend/target/ui-check");
await fs.mkdir(scratch, { recursive: true });
const fixture = await fs.mkdtemp(path.join(scratch, "amiro-schedules-"));
async function freePort() {
  const reservation = net.createServer();
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const availablePort = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  return availablePort;
}
const port = Number(process.env.AMIRO_SCHEDULE_TEST_PORT || (await freePort()));
const withRuntime = process.env.AMIRO_SCHEDULE_TEST_RUNTIME === "1";
const socketDir = await fs.mkdtemp(path.join(os.tmpdir(), "amx-sched-"));
const socket = path.join(socketDir, "api.sock");
const stubPort = await freePort();
const stub = withRuntime
  ? spawn(
      "python3",
      [path.join(ROOT, "scripts/native-stub-provider.py"), String(stubPort)],
      {
        stdio: "ignore",
        env: {
          ...process.env,
          AMIRO_STUB_EXPECT_MODEL: "stub-scheduled-model",
          AMIRO_STUB_REQUEST_LOG: path.join(fixture, "provider-requests.jsonl"),
        },
      },
    )
  : null;
const base = `http://127.0.0.1:${port}`;
const binary =
  process.env.AMIRO_BACKEND_BIN ||
  path.join(ROOT, "backend/target/debug/amiro-backend");
const log = await fs.open(path.join(fixture, "backend.log"), "a");
const child = spawn(binary, [], {
  cwd: ROOT,
  env: {
    ...process.env,
    AMIRO_HOME: path.join(fixture, "home"),
    AMIRO_SKIP_ONBOARDING: "1",
    AMIRO_RUNTIME_HOME: path.join(fixture, "runtime"),
    AMIRO_API_SOCKET: socket,
    AMIRO_RUNTIME_BIN:
      process.env.AMIRO_RUNTIME_BIN ||
      path.join(ROOT, "runtime/target/debug/amiro-runtime"),
    AMIRO_NO_RUNTIME_SPAWN: withRuntime ? "0" : "1",
    AMIRO_NO_RUNTIME_KEEPALIVE: withRuntime ? "0" : "1",
    AMIRO_OPENAI_COMPAT_API_BASE: `http://127.0.0.1:${stubPort}/v1`,
    AMIRO_OPENAI_COMPAT_API_KEY_NAME: "AMIRO_SCHEDULE_STUB_KEY",
    AMIRO_SCHEDULE_STUB_KEY: "stub-key",
    AMIRO_DEFAULT_MODEL: "openai-compatible:stub-model",
    AMIRO_PINNED_MODELS: "openai-compatible:stub-model,openai-compatible:stub-scheduled-model",
    AMIRO_TOOL_PROFILE: "none",
    AMIRO_NO_TELEMETRY: "1",
    XDG_CONFIG_HOME: path.join(fixture, "config"),
    XDG_DATA_HOME: path.join(fixture, "data"),
    AMIRO_HOST: "127.0.0.1",
    AMIRO_PORT: String(port),
    AMIRO_TOKEN: "",
    AMIRO_OWNER_EMAIL: "owner@amiro.test",
    AMIRO_OWNER_PASSWORD: "schedules-ui-owner-1",
    AMIRO_OUT_DIR: path.join(ROOT, "clients", "web", "out"),
  },
  stdio: ["ignore", log.fd, log.fd],
});
let browser;
let page;
const errors = [];
const results = [];
console.log(`Schedule verification fixture: ${fixture}`);
function check(name, condition) {
  assert.ok(condition, name);
  results.push({ name, ok: true });
  console.log(`PASS ${name}`);
}
try {
  for (let i = 0; i < 150; i += 1) {
    if (child.exitCode !== null)
      throw new Error(`Backend exited: ${child.exitCode}`);
    try {
      if (
        (await fetch(`${base}/health`, { signal: AbortSignal.timeout(3000) }))
          .ok
      )
        break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const credentials = {
    email: "owner@amiro.test",
    password: "schedules-ui-owner-1",
  };
  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(credentials),
  });
  assert.equal(login.status, 200, "fixture login");
  const { token } = await login.json();
  assert.ok(token, "fixture token");
  browser = await chromium.launch({
    executablePath: process.env.AMIRO_UI_BROWSER || "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext({
    viewport: { width: 1360, height: 900 },
    timezoneId: "UTC",
  });
  await context.addInitScript(
    (value) => localStorage.setItem("amiro.session-token", value),
    token,
  );
  page = await context.newPage();
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(`${base}/schedules`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Schedules", exact: true }).waitFor();
  check("native schedules route renders", true);
  check(
    "manual Agent runs navigation removed",
    (await page.locator('a[href="/runs"]').count()) === 0,
  );
  await page.screenshot({
    path: path.join(fixture, "schedules-empty.png"),
    fullPage: true,
  });

  const api = async (route, options = {}) => {
    const response = await fetch(`${base}${route}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });
    assert.ok(
      response.ok,
      `${options.method || "GET"} ${route}: ${response.status} ${await response.clone().text()}`,
    );
    return response.status === 204 ? null : response.json();
  };
  const waitForMutation = (method, route) =>
    page.waitForResponse(
      (response) =>
        response.url() === `${base}${route}` &&
        response.request().method() === method,
    );
  const waitForRun = async (id) => {
    for (let i = 0; i < 120; i += 1) {
      const { runs } = await api(`/api/schedules/${id}/runs`);
      const run = runs.find(
        (value) => value.status === "ok" || value.status === "failed",
      );
      if (run) {
        assert.equal(run.status, "ok", JSON.stringify(run));
        return run;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`Schedule ${id} did not finish`);
  };

  await page.getByTestId("schedules-empty-create-button").click();
  await page.getByTestId("schedule-name-input").fill("Daily planning reminder");
  await page
    .getByTestId("schedule-prompt-input")
    .fill("Review priorities for today");
  await page.getByTestId("schedule-mode-notify").click();
  await page.getByTestId("schedule-cadence-daily").click();
  await page.getByTestId("schedule-daily-time-input").fill("09:00");
  await page.getByTestId("schedule-preview-item").first().waitFor();
  await page.screenshot({
    path: path.join(fixture, "schedule-create-dialog.png"),
    fullPage: true,
  });
  let mutation = waitForMutation("POST", "/api/schedules");
  await page.getByTestId("schedule-dialog-save").click();
  let response = await mutation;
  assert.equal(response.status(), 201, await response.text());
  let { schedule } = await response.json();
  const id = schedule.id;
  await page.getByTestId(`schedule-row-${id}`).waitFor();
  check(
    "create daily reminder through UI",
    schedule.mode === "notify" && schedule.schedule.expression === "0 9 * * *",
  );
  check("preview lists next runs", !!schedule.nextRunAt);

  mutation = waitForMutation("PATCH", `/api/schedules/${id}`);
  await page.getByTestId(`schedule-toggle-${id}`).click();
  response = await mutation;
  schedule = (await response.json()).schedule;
  check("pause schedule through UI", schedule.enabled === false);
  mutation = waitForMutation("PATCH", `/api/schedules/${id}`);
  await page.getByTestId(`schedule-toggle-${id}`).click();
  response = await mutation;
  check(
    "resume schedule through UI",
    (await response.json()).schedule.enabled === true,
  );

  await page.getByTestId(`schedule-edit-${id}`).click();
  await page.getByTestId("schedule-name-input").fill("Planning reminder");
  mutation = waitForMutation("PATCH", `/api/schedules/${id}`);
  await page.getByTestId("schedule-dialog-save").click();
  response = await mutation;
  check(
    "edit schedule through UI",
    (await response.json()).schedule.name === "Planning reminder",
  );

  mutation = waitForMutation("POST", `/api/schedules/${id}/run`);
  await page.getByTestId(`schedule-run-now-${id}`).click();
  response = await mutation;
  assert.ok(response.ok(), await response.text());
  const reminderRun = await waitForRun(id);
  check("run-now persists a successful reminder", !!reminderRun.threadId);
  const thread = await api(`/api/thread/${reminderRun.threadId}`);
  check(
    "reminder delivered as visible conversation text",
    thread.messages.some((message) =>
      message.parts?.some(
        (part) => part.text === "Review priorities for today",
      ),
    ),
  );
  await page.getByTestId(`schedule-row-select-${id}`).click();
  await page.getByTestId("schedule-detail").waitFor();
  await page.getByTestId(`schedule-run-${reminderRun.id}`).waitFor();
  check("run history displays actual backend result", true);
  await page.screenshot({
    path: path.join(fixture, "schedules-desktop.png"),
    fullPage: true,
  });

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByTestId(`schedule-row-${id}`).waitFor();
  check("saved schedules survive browser reload", true);

  await page.getByTestId("schedules-search-input").fill("no-such-schedule");
  await page.getByTestId("schedules-no-results").waitFor();
  await page.getByTestId("schedules-clear-filters-button").click();
  await page.getByTestId(`schedule-row-${id}`).waitFor();
  check("schedule search and clear filters work", true);

  const custom = (
    await api("/api/schedules", {
      method: "POST",
      body: JSON.stringify({
        name: "Custom cadence",
        prompt: "Preserve this custom cron",
        mode: "notify",
        timezone: "UTC",
        schedule: { kind: "cron", expression: "*/5 * * * *" },
      }),
    })
  ).schedule;
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByTestId(`schedule-edit-${custom.id}`).click();
  check(
    "custom cron is not silently converted to a preset",
    (await page.getByTestId("schedule-cron-input").inputValue()) ===
      "*/5 * * * *",
  );
  await page.getByTestId("schedule-name-input").fill("Custom cadence renamed");
  mutation = waitForMutation("PATCH", `/api/schedules/${custom.id}`);
  await page.getByTestId("schedule-dialog-save").click();
  response = await mutation;
  check(
    "editing custom cron preserves exact expression",
    (await response.json()).schedule.schedule.expression === "*/5 * * * *",
  );
  await page.getByTestId(`schedule-delete-${custom.id}`).click();
  await page.getByTestId("schedule-delete-cancel").click();
  await page.getByTestId("schedule-delete-dialog").waitFor({ state: "hidden" });
  check(
    "deletion requires confirmation",
    !!(await api(`/api/schedules/${custom.id}`)).schedule,
  );
  await page.getByTestId(`schedule-delete-${custom.id}`).click();
  mutation = waitForMutation("DELETE", `/api/schedules/${custom.id}`);
  await page.getByTestId("schedule-delete-confirm").click();
  assert.equal((await mutation).status(), 204);
  await page.getByTestId("schedule-delete-dialog").waitFor({ state: "hidden" });
  check("confirmed schedule deletion works", true);

  await page.getByTestId("schedules-create-button").click();
  await page.getByTestId("schedule-name-input").fill("Tokyo one-time reminder");
  await page
    .getByTestId("schedule-prompt-input")
    .fill("Timezone browser acceptance");
  await page.getByTestId("schedule-mode-notify").click();
  await page.getByTestId("schedule-timezone-select").click();
  await page.getByRole("option", { name: "Asia/Tokyo", exact: true }).click();
  await page.getByTestId("schedule-cadence-once").click();
  await page.getByTestId("schedule-once-at-input").fill("2030-05-06T09:00");
  await page.getByTestId("schedule-preview-item").first().waitFor();
  mutation = waitForMutation("POST", "/api/schedules");
  await page.getByTestId("schedule-dialog-save").click();
  response = await mutation;
  assert.equal(response.status(), 201, await response.text());
  const tokyo = (await response.json()).schedule;
  check(
    "once uses selected zone rather than browser zone",
    tokyo.nextRunAt.startsWith("2030-05-06T00:00:00"),
  );
  await page.getByTestId(`schedule-edit-${tokyo.id}`).click();
  check(
    "once editing restores selected-zone wall time",
    (await page.getByTestId("schedule-once-at-input").inputValue()) ===
      "2030-05-06T09:00",
  );
  await page.getByTestId("schedule-dialog-cancel").click();
  await api(`/api/schedules/${tokyo.id}`, { method: "DELETE" });

  if (withRuntime) {
    const created = await api("/api/schedules", {
      method: "POST",
      body: JSON.stringify({
        name: "Runtime acceptance",
        prompt: "Return the local stub greeting",
        mode: "execute",
        model: "openai-compatible:stub-scheduled-model",
        timezone: "UTC",
        schedule: { kind: "interval", minutes: 60 },
      }),
    });
    await api(`/api/schedules/${created.schedule.id}/run`, { method: "POST" });
    const executed = await waitForRun(created.schedule.id);
    const executedThread = await api(`/api/thread/${executed.threadId}`);
    check(
      "scheduled execute reaches real owned runtime and local provider",
      executedThread.messages.some((message) =>
        message.parts?.some((part) =>
          part.text?.includes("Hello from the local stub provider."),
        ),
      ),
    );
    check(
      "scheduled execute thread preserves user prompt before assistant reply (Vellum parity)",
      executedThread.messages.length >= 2 &&
        executedThread.messages[0]?.role === "user" &&
        executedThread.messages[0]?.parts?.some(
          (part) => part.text === "Return the local stub greeting",
        ) &&
        executedThread.messages[1]?.role === "assistant",
    );
    const requests = (await fs.readFile(path.join(fixture, "provider-requests.jsonl"), "utf8"))
      .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    check(
      "saved schedule model overrides daemon default at the provider",
      requests.some((request) => request.model === "stub-scheduled-model"),
    );
    check(
      "scheduled execution exposes no tools to the provider",
      requests
        .filter((request) => request.model === "stub-scheduled-model")
        .every((request) => request.toolsCount === 0),
    );
    await api(`/api/schedules/${created.schedule.id}`, { method: "DELETE" });
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: path.join(fixture, "schedules-mobile.png"),
    fullPage: true,
  });
  check(
    "mobile page has no horizontal overflow",
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.getByTestId(`schedule-edit-${id}`).click();
  await page.screenshot({
    path: path.join(fixture, "schedule-dialog-mobile.png"),
    fullPage: true,
  });
  check(
    "mobile dialog fits viewport",
    await page.getByTestId("schedule-dialog").evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return rect.left >= 0 && rect.right <= innerWidth + 1;
    }),
  );
  await page.getByTestId("schedule-dialog-cancel").click();
  check("no client exception", errors.length === 0);
  await fs.writeFile(
    path.join(fixture, "results.json"),
    JSON.stringify({ results, errors }, null, 2),
  );
  console.log(`Schedule browser evidence: ${fixture}`);
} catch (error) {
  await page
    ?.screenshot({ path: path.join(fixture, "failure.png"), fullPage: true })
    .catch(() => {});
  await fs.writeFile(
    path.join(fixture, "results.json"),
    JSON.stringify({ results, errors, failure: String(error) }, null, 2),
  );
  throw error;
} finally {
  await browser?.close();
  child.kill("SIGTERM");
  stub?.kill("SIGTERM");
  if (withRuntime)
    spawnSync("pkill", ["-f", "--", `--api-socket ${socket}`], {
      stdio: "ignore",
    });
  await log.close();
}
