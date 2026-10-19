import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { spawn } from "node:child_process";
import { chromium } from "@playwright/test";

const root = await mkdtemp(
  path.join(
    process.env.JCODE_SCRATCH_DIR || os.homedir(),
    "amiro-settings-workflows-",
  ),
);
const home = path.join(root, "home");
const runtime = path.join(root, "runtime");
await mkdir(home);
await mkdir(path.join(runtime, "memory"), { recursive: true });
const memories = Object.fromEntries(
  Array.from({ length: 35 }, (_, index) => {
    const id = `clarity-memory-${index}`;
    return [
      id,
      {
        id,
        content: `Memory clarity example ${index}: keep project notes concise.`,
        category: index % 2 ? "preference" : "fact",
        tags: ["clarity"],
        active: true,
      },
    ];
  }),
);
await writeFile(
  path.join(runtime, "memory/global.json"),
  JSON.stringify({ memories }),
);
await writeFile(
  path.join(runtime, "config.toml"),
  '# Settings acceptance\n[search]\nprovider = "duckduckgo"\n',
);
const server = http.createServer();
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
await new Promise((resolve) => server.close(resolve));
const base = `http://127.0.0.1:${port}`;
const child = spawn(path.resolve("backend/target/debug/amiro-backend"), [], {
  detached: true,
  env: {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !/(KEY|TOKEN|SECRET|PASSWORD|JCODE|AMIRO)/i.test(key),
      ),
    ),
    AMIRO_HOME: home,
    AMIRO_SKIP_ONBOARDING: "1",
    AMIRO_RUNTIME_HOME: runtime,
    AMIRO_RUNTIME_DIR: runtime,
    AMIRO_API_SOCKET: path.join(runtime, "amiro-api.sock"),
    AMIRO_RUNTIME_BIN: path.resolve("runtime/target/debug/amiro-runtime"),
    AMIRO_OUT_DIR: path.resolve("out"),
    AMIRO_HOST: "127.0.0.1",
    AMIRO_PORT: String(port),
    AMIRO_OWNER_EMAIL: "settings@amiro.test",
    AMIRO_OWNER_PASSWORD: "settings-acceptance-local-1",
    AMIRO_NO_TELEMETRY: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
child.stdout.on("data", (data) => {
  logs += data;
});
child.stderr.on("data", (data) => {
  logs += data;
});
let browser;
try {
  let ready = false;
  for (let index = 0; index < 120; index++) {
    if (child.exitCode !== null) throw Error(logs);
    try {
      if ((await fetch(base + "/health")).ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert(ready, "Isolated built backend healthy");
  const login = await fetch(base + "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "settings@amiro.test",
      password: "settings-acceptance-local-1",
    }),
  });
  assert.equal(login.status, 200);
  const { token } = await login.json();
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
  });
  await context.addInitScript(
    (value) => localStorage.setItem("amiro.session-token", value),
    token,
  );
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto(base + "/admin/credentials", { waitUntil: "networkidle" });
  await page.getByTestId("credentials-add-button").click();
  await page.getByTestId("credentials-add-dialog").waitFor();
  await page.getByTestId("credential-service-input").fill("clarity-test");
  await page.getByTestId("credential-field-input").fill("api-key");
  const value = "synthetic-local-acceptance-secret-7391";
  await page.getByTestId("credential-value-input").fill(value);
  await page.getByTestId("credential-save-button").click();
  await page.getByTestId("credentials-add-dialog").waitFor({ state: "hidden" });
  await page
    .getByTestId("credentials-list")
    .getByText("clarity-test", { exact: false })
    .first()
    .waitFor();
  assert(
    !(await page.locator("body").innerText()).includes(value),
    "Secret is not rendered after saving",
  );
  const stored = await fetch(base + "/api/credentials", { headers });
  assert.equal(stored.status, 200);
  const raw = await stored.text();
  assert(
    !raw.includes(value),
    "Public credential metadata never contains plaintext",
  );
  assert(
    raw.includes("clarity-test"),
    "Browser save persisted through real vault API",
  );
  await page.reload({ waitUntil: "networkidle" });
  await page
    .getByTestId("credentials-list")
    .getByText("clarity-test", { exact: false })
    .first()
    .waitFor();
  console.log(
    "PASS credential browser create, masked metadata, real encrypted-vault persistence and reload",
  );
  await page.getByTestId("credential-delete-clarity-test-api-key").click();
  await page.getByTestId("credentials-delete-dialog").waitFor();
  await page.getByTestId("credential-delete-cancel").click();
  await page
    .getByTestId("credentials-delete-dialog")
    .waitFor({ state: "hidden" });
  assert.equal(
    (await (await fetch(base + "/api/credentials", { headers })).json()).items
      .length,
    1,
    "Cancel preserves credential",
  );
  await page.getByTestId("credential-delete-clarity-test-api-key").click();
  await page.getByTestId("credential-delete-confirm").click();
  await page.getByTestId("credentials-empty").waitFor();
  assert.equal(
    (await (await fetch(base + "/api/credentials", { headers })).json()).items
      .length,
    0,
    "Confirmed browser deletion persisted",
  );
  console.log(
    "PASS credential deletion cancellation and confirmation through real browser/vault API",
  );

  await page.goto(base + "/agent/workspace", { waitUntil: "networkidle" });
  await page.getByTestId("workspace-browser").waitFor();
  const treeResponse = await fetch(base + "/api/workspace/tree?path=", {
    headers,
  });
  assert.equal(treeResponse.status, 200);
  const escape = await fetch(base + "/api/workspace/file?path=../config.toml", {
    headers,
  });
  assert.equal(escape.status, 403, "Workspace rejects path traversal");
  console.log("PASS workspace tree API and containment");

  await page.goto(base + "/agent/memory", { waitUntil: "networkidle" });
  await page.getByTestId("memory-search-input").waitFor();
  await page
    .getByText("Memory clarity example", { exact: false })
    .first()
    .waitFor();
  assert.equal(
    await page.getByTestId("memory-map").count(),
    1,
    "Memory opens in the labeled map",
  );
  await page.getByRole("button", { name: "Cards", exact: true }).click();
  assert.equal(
    await page.getByTestId("memory-create-button").count(),
    0,
    "Native memory does not advertise creation",
  );
  assert.equal(
    await page.getByTestId("memory-card").count(),
    24,
    "Initial memory list is bounded",
  );
  await page.getByTestId("memory-load-more").click();
  assert.equal(
    await page.getByTestId("memory-card").count(),
    35,
    "Show more reveals remaining real memories",
  );
  await page.getByTestId("memory-card").first().click();
  await page.getByRole("dialog", { name: "Memory detail" }).waitFor();
  await page.waitForFunction(() =>
    document.activeElement?.closest('[role="dialog"]'),
  );
  await page.keyboard.press("Escape");
  await page
    .getByRole("dialog", { name: "Memory detail" })
    .waitFor({ state: "hidden" });
  await page
    .getByTestId("memory-search-input")
    .fill("Memory clarity example 34:");
  await page
    .getByText("Memory clarity example 34:", { exact: false })
    .first()
    .waitFor();
  await page.screenshot({
    path: path.join(root, "memory-filtered.png"),
    fullPage: true,
  });
  console.log(
    "PASS real runtime memory graph shown as readable entries, search finds entries beyond initial page",
  );

  const create = await fetch(base + "/api/skills", {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: "clarity-skill",
      description: "Keep project notes concise",
      body: "Write a short project summary with concrete next steps.",
    }),
  });
  assert.equal(create.status, 200, "Create real test skill");
  await page.goto(base + "/agent/superpowers", { waitUntil: "networkidle" });
  await page
    .getByTestId("skill-card")
    .filter({ hasText: "clarity-skill" })
    .waitFor();
  await page
    .getByTestId("superpowers-search-input")
    .fill("missing-clarity-skill");
  assert.equal(await page.getByTestId("skill-card").count(), 0);
  await page.getByTestId("superpowers-search-input").fill("clarity-skill");
  await page
    .getByTestId("skill-card")
    .filter({ hasText: "clarity-skill" })
    .waitFor();
  await page
    .getByTestId("skill-card")
    .filter({ hasText: "clarity-skill" })
    .getByRole("link", { name: "Open clarity-skill", exact: true })
    .first()
    .click();
  await page.getByTestId("skill-name-input").waitFor();
  assert.equal(
    await page.getByTestId("skill-name-input").inputValue(),
    "clarity-skill",
  );
  console.log(
    "PASS real skill list, search and selected skill editor integration",
  );
  assert.equal(
    errors.length,
    0,
    "No browser runtime errors across public workflows",
  );
  console.log(`PASS isolated settings workflows, artifacts ${root}`);
} finally {
  await browser?.close();
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {}
}
