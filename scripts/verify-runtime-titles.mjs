import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { spawn } from "node:child_process";
import { chromium } from "@playwright/test";

const root = await mkdtemp(
  path.join(
    process.env.JCODE_SCRATCH_DIR || os.homedir(),
    "amiro-title-acceptance-",
  ),
);
const home = path.join(root, "home");
const runtimeHome = path.join(root, "runtime");
await mkdir(home);
await mkdir(runtimeHome);
const requests = [];
const provider = http.createServer(async (req, res) => {
  let text = "";
  for await (const chunk of req) text += chunk;
  if (req.url?.startsWith("/v1/models")) {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ data: [{ id: "title-fixture" }] }));
    return;
  }
  if (!req.url?.startsWith("/v1/chat/completions")) {
    res.writeHead(404);
    res.end();
    return;
  }
  requests.push(JSON.parse(text));
  res.setHeader("Content-Type", "text/event-stream");
  const event = (delta) =>
    `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "title-fixture", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`;
  res.write(event({ role: "assistant", content: "Title acceptance reply" }));
  res.write(
    `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "title-fixture", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
  );
  res.end("data: [DONE]\n\n");
});
await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
const providerBase = `http://127.0.0.1:${provider.address().port}/v1`;
const portServer = http.createServer();
await new Promise((resolve) => portServer.listen(0, "127.0.0.1", resolve));
const port = portServer.address().port;
await new Promise((resolve) => portServer.close(resolve));
const base = `http://127.0.0.1:${port}`;
const backendBin = path.resolve("backend/target/debug/amiro-backend");
const runtimeBin = path.resolve("runtime/target/debug/amiro-runtime");
const child = spawn(backendBin, [], {
  env: {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/(KEY|TOKEN|SECRET|PASSWORD|JCODE|AMIRO)/i.test(name))),
    AMIRO_HOME: home,
    AMIRO_SKIP_ONBOARDING: "1",
    AMIRO_RUNTIME_HOME: runtimeHome,
    AMIRO_RUNTIME_DIR: runtimeHome,
    AMIRO_API_SOCKET: path.join(runtimeHome, "amiro-api.sock"),
    AMIRO_RUNTIME_BIN: runtimeBin,
    AMIRO_OPENAI_COMPAT_API_BASE: providerBase,
    OPENAI_COMPAT_API_KEY: "fixture-not-real",
    AMIRO_OUT_DIR: path.resolve("out"),
    AMIRO_HOST: "127.0.0.1",
    AMIRO_PORT: String(port),
    AMIRO_OWNER_EMAIL: "title@amiro.test",
    AMIRO_OWNER_PASSWORD: "title-acceptance-fixture-1",
    AMIRO_NO_TELEMETRY: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
child.stdout.on("data", (x) => (logs += x));
child.stderr.on("data", (x) => (logs += x));
let browser;
try {
  let ready = false;
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw Error(logs);
    try {
      const r = await fetch(base + "/health");
      if (r.ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  assert(ready, "fixture backend healthy");
  const login = await fetch(base + "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "title@amiro.test",
      password: "title-acceptance-fixture-1",
    }),
  });
  assert.equal(login.status, 200);
  const auth = await login.json();
  const token = auth.token;
  assert(token, "login session token");
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({
    viewport: { width: 1360, height: 950 },
  });
  await context.addInitScript(
    (token) => localStorage.setItem("amiro.session-token", token),
    token,
  );
  const page = await context.newPage();
  const titleCalls = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/chat/title")) titleCalls.push(r.url());
  });
  await page.route("**/api/chat", async (route) => {
    const body = route.request().postDataJSON();
    body.chatModel = { provider: "openai-compatible", model: "title-fixture" };
    await route.continue({ postData: JSON.stringify(body) });
  });
  await page.goto(base + "/");
  const input = page
    .locator(
      '[data-testid="chat-input"] textarea, [data-testid="chat-input"] [contenteditable="true"], [data-testid="chat-input"] input',
    )
    .first();
  await input.waitFor();
  const prompt = "Verify runtime chat title mapping";
  await input.fill(prompt);
  await page.getByTestId("chat-send-button").click();
  await page
    .getByText("Title acceptance reply", { exact: false })
    .first()
    .waitFor({ timeout: 60000 });
  const headers = { Authorization: "Bearer " + token };
  let threads = [];
  for (let i = 0; i < 60; i++) {
    const r = await fetch(base + "/api/thread", { headers });
    threads = await r.json();
    if (threads.some((t) => t.title === prompt)) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const thread = threads.find((t) => t.title === prompt);
  assert(thread, "thread list mapped runtime title");
  await page
    .getByTestId("sidebar-thread-title")
    .filter({ hasText: prompt })
    .first()
    .waitFor();
  const stored = JSON.parse(
    await readFile(path.join(home, "threads.json"), "utf8"),
  );
  assert.equal(stored[thread.id].titleSource, "runtime");
  assert.equal(titleCalls.length, 0, "browser makes no separate title request");
  assert.equal(
    requests.filter((request) => request.model === "title-fixture").length,
    1,
    "one chat inference, no cosmetic title turn",
  );
  const rename = await fetch(base + "/api/thread/" + thread.id, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ title: "My manual title" }),
  });
  assert.equal(rename.status, 200);
  const titleResponse = await fetch(base + "/api/chat/title", {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      threadId: thread.id,
      message: "overwrite attempted",
    }),
  });
  assert.equal(titleResponse.status, 200);
  assert((await titleResponse.text()).includes("My manual title"));
  assert.equal(requests.filter((request) => request.model === "title-fixture").length, 1);
  await page.reload();
  await page
    .getByTestId("sidebar-thread-title")
    .filter({ hasText: "My manual title" })
    .first()
    .waitFor();
  await page.screenshot({
    path: path.join(root, "runtime-title.png"),
    fullPage: true,
  });
  console.log(
    JSON.stringify({
      checks: [
        "actual browser sends chat",
        "runtime title persisted and sidebar visible",
        "no separate title request",
        "one chat inference only (optional runtime memory requests excluded)",
        "manual rename preserved by title sync",
        "title survives reload",
      ],
      artifactRoot: root,
    }),
  );
} finally {
  if (browser) await browser.close();
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    if (child.exitCode !== null) resolve();
    else {
      child.once("exit", resolve);
      setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 3000).unref();
    }
  });
  try {
    const servers = JSON.parse(
      await readFile(path.join(runtimeHome, "servers.json"), "utf8"),
    );
    for (const entry of Object.values(servers)) {
      if (entry.socket?.startsWith(runtimeHome) && entry.pid)
        process.kill(entry.pid, "SIGTERM");
    }
  } catch {}
  await new Promise((resolve) => provider.close(resolve));
  await writeFile(path.join(root, "backend.log"), logs);
}
