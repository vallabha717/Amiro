#!/usr/bin/env node
// Regenerates the screenshots and GIFs used by README.md.
//
//   node scripts/capture-readme-media.mjs            # everything
//   node scripts/capture-readme-media.mjs --only chat,schedules
//   node scripts/capture-readme-media.mjs --keep     # leave the servers up
//
// Needs: out/ (pnpm build), a release backend (scripts/build-native.sh),
// a runtime binary, Chrome or Playwright's Chromium, and ffmpeg on PATH for
// the GIFs. Everything runs against throwaway instances under a scratch dir:
// its own HOME, AMIRO_HOME and runtime home, on ports 3930-3939, with a local
// scripted OpenAI-compatible model so chat replies stream like a real one.
// No real provider is called and no existing Amiro install is touched.
//
// Environment overrides:
//   AMIRO_BACKEND_BIN, AMIRO_RUNTIME_BIN, AMIRO_OUT_DIR, AMIRO_UI_BROWSER,
//   AMIRO_CAPTURE_SCRATCH (scratch dir), AMIRO_CAPTURE_PORT_BASE (default 3930),
//   FFMPEG (path to ffmpeg).
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pw from "@playwright/test";

const { chromium } = pw;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ASSETS = path.join(ROOT, "docs/assets/readme");
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const ONLY = opt("only")?.split(",").map((s) => s.trim()) ?? null;
const wants = (name) => !ONLY || ONLY.includes(name);

const PORT_BASE = Number(process.env.AMIRO_CAPTURE_PORT_BASE || 3930);
const PORTS = {
  stub: PORT_BASE + 3,
  onboarding: PORT_BASE + 1,
  main: PORT_BASE + 2,
};
const BACKEND_BIN =
  process.env.AMIRO_BACKEND_BIN ||
  path.join(ROOT, "backend/target/release/amiro-backend");
const RUNTIME_BIN =
  process.env.AMIRO_RUNTIME_BIN ||
  [
    path.join(ROOT, "clients/desktop/binaries/runtime-x86_64-unknown-linux-gnu"),
    path.join(ROOT, "runtime/target/release/amiro-runtime"),
    path.join(ROOT, "runtime/target/debug/amiro-runtime"),
  ].find((p) => fs.existsSync(p));
const OUT_DIR = process.env.AMIRO_OUT_DIR || path.join(ROOT, "clients", "web", "out");
const SCRATCH =
  process.env.AMIRO_CAPTURE_SCRATCH ||
  fs.mkdtempSync(path.join(os.tmpdir(), "amiro-readme-"));
// Unix socket paths are capped at ~108 bytes, so sockets get a short dir.
const SOCKETS = fs.mkdtempSync("/tmp/amr-");
const FFMPEG = process.env.FFMPEG || "ffmpeg";
const BROWSER =
  process.env.AMIRO_UI_BROWSER ||
  (fs.existsSync("/usr/bin/google-chrome") ? "/usr/bin/google-chrome" : undefined);

for (const [what, p] of [
  ["backend", BACKEND_BIN],
  ["runtime", RUNTIME_BIN],
  ["clients/web/out/index.html", OUT_DIR && path.join(OUT_DIR, "index.html")],
]) {
  if (!p || !fs.existsSync(p)) {
    console.error(`capture: ${what} not found (${p}). Build it first.`);
    process.exit(2);
  }
}
fs.mkdirSync(ASSETS, { recursive: true });
console.log(`scratch: ${SCRATCH}`);

const OWNER = {
  email: "ada@example.com",
  password: "readme-capture-owner-1",
  name: "Ada",
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Scripted model: an OpenAI-compatible endpoint whose answers are written for
// the README. It streams token by token, like a real provider.
// ---------------------------------------------------------------------------

const REPLIES = [
  {
    match: /launch/i,
    text: `Here's a week that protects launch prep and keeps the three interviews from breaking up your focus time.

| Day | Focus | Notes |
| --- | --- | --- |
| **Mon** | Launch checklist, final copy | Interview 1 at 15:00 |
| **Tue** | Deep work on the demo | No meetings before 13:00 |
| **Wed** | Dry run with the team | Interviews 2 and 3, back to back from 14:00 |
| **Thu** | 🚀 **Launch** | Keep the afternoon clear for follow-ups |
| **Fri** | Retro and inbox zero | Short day |

**Two things I'd move:**

1. The design sync on Thursday morning. It collides with launch, and Friday works for everyone on the invite.
2. Interview 3. Back-to-back slots on Wednesday leave no buffer before the dry run, so 16:30 is safer.

I've added the launch to \`NOW.md\` so I keep it in mind. Want a reminder on Wednesday at 17:00 to send the launch checklist?`,
  },
  {
    match: /^(yes|sure)\b|add .*reminder/i,
    text: `Done. **Send the launch checklist** will run on Wednesday at 17:00 in your timezone, and the reminder will land in this chat. You can pause or edit it from **Schedules**.`,
  },
  {
    match: /budget|sam/i,
    text: `Here's a draft:

> Hi Sam, thanks for the Q3 numbers. The overall budget works for us. The one line I'd revisit is contractor spend in August, which runs ahead of the hiring plan. Could we move half of it to September? Happy to talk it through on Thursday.

It's short, agrees on the whole, and asks for one concrete change. Want it warmer or more formal?`,
  },
  {
    match: /dinner|chickpea/i,
    text: `**Crispy chickpea and spinach skillet**, about 20 minutes:

1. Fry a drained can of chickpeas in olive oil until crisp, about 8 minutes.
2. Add garlic, cumin and smoked paprika for a minute.
3. Stir in a tin of tomatoes, simmer for 5 minutes, then wilt in two handfuls of spinach.
4. Finish with lemon and a spoon of yogurt.

Serve with flatbread. It keeps well for lunch tomorrow.`,
  },
  {
    match: /sleep|article/i,
    text: `**The short version:** consistency beats duration. Keeping the same wake time every day, weekends included, did more for how rested people felt than adding an extra hour in bed.

- Morning light within an hour of waking helps set the clock.
- Caffeine after 14:00 measurably cut deep sleep.
- A cool room (around 18 °C) helped more than any supplement studied.

I saved the key points to \`notes/sleep.md\`.`,
  },
];
const FALLBACK = "Got it. I'll keep that in mind.";

// The runtime sends the typed message as its own user message (prefixed with
// a timestamp) next to user messages that only carry <system-reminder>
// context. Pick the latest one with real text in it.
function lastUserText(messages) {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.role !== "user") continue;
    const raw =
      typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? m.content.map((p) => p.text ?? "").join(" ")
          : "";
    const text = raw
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
      .replace(/^\s*\[[^\]]+\]\s*/, "")
      .trim();
    if (text) return text;
  }
  return "";
}

function tokenize(text) {
  return text.match(/\S+\s*|\s+/g) ?? [];
}

function startStub(port) {
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", async () => {
      if (req.method === "GET" && req.url.startsWith("/v1/models")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            object: "list",
            data: [{ id: "demo-model", object: "model" }],
          }),
        );
        return;
      }
      if (!req.url.startsWith("/v1/chat/completions")) {
        res.writeHead(404);
        res.end();
        return;
      }
      let body = {};
      try {
        body = JSON.parse(raw || "{}");
      } catch {}
      const prompt = lastUserText(body.messages);
      fs.appendFileSync(
        path.join(SCRATCH, "stub-requests.jsonl"),
        `${JSON.stringify({ model: body.model, prompt: prompt.slice(0, 80), raw: process.env.CAPTURE_DEBUG ? body.messages : undefined })}\n`,
      );
      // Side calls the runtime makes on its own (memory, titles) quote the
      // transcript; they get the short fallback instead of a scripted reply.
      const side = prompt.startsWith("**User:**");
      const reply =
        (!side && REPLIES.find((r) => r.match.test(prompt))?.text) || FALLBACK;
      const model = body.model || "demo-model";
      const send = (delta, finish = null) =>
        res.write(
          `data: ${JSON.stringify({
            id: "chatcmpl-demo",
            object: "chat.completion.chunk",
            model,
            choices: [{ index: 0, delta, finish_reason: finish }],
          })}\n\n`,
        );
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "close",
      });
      send({ role: "assistant", content: "" });
      await sleep(350);
      for (const piece of tokenize(reply)) {
        send({ content: piece });
        await sleep(22);
      }
      send({}, "stop");
      res.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-demo",
          object: "chat.completion.chunk",
          model,
          choices: [],
          usage: { prompt_tokens: 1200, completion_tokens: 180, total_tokens: 1380 },
        })}\n\n`,
      );
      res.end("data: [DONE]\n\n");
    });
  });
  return new Promise((resolve) =>
    server.listen(port, "127.0.0.1", () => resolve(server)),
  );
}

// ---------------------------------------------------------------------------
// Isolated backends
// ---------------------------------------------------------------------------

const children = [];
// Videos start when the page is created; we record that moment to trim.
const pageCreated = new WeakMap();

async function startBackend(name, port, extraEnv = {}, prepare) {
  const dir = path.join(SCRATCH, name);
  const home = path.join(dir, "home");
  const runtimeHome = path.join(dir, "runtime");
  for (const d of [home, runtimeHome, path.join(dir, "run"), path.join(dir, "user")])
    fs.mkdirSync(d, { recursive: true });
  await prepare?.({ dir, home, runtimeHome });
  const token = crypto.randomBytes(16).toString("hex");
  const log = fs.openSync(path.join(dir, "backend.log"), "a");
  const env = {
    PATH: process.env.PATH,
    LANG: "en_US.UTF-8",
    TZ: "Europe/London",
    HOME: path.join(dir, "user"),
    XDG_CONFIG_HOME: path.join(dir, "user/.config"),
    XDG_DATA_HOME: path.join(dir, "user/.local/share"),
    XDG_CACHE_HOME: path.join(dir, "user/.cache"),
    AMIRO_HOME: home,
    AMIRO_RUNTIME_HOME: runtimeHome,
    AMIRO_RUNTIME_DIR: path.join(dir, "run"),
    AMIRO_API_SOCKET: path.join(SOCKETS, `${name}.sock`),
    AMIRO_RUNTIME_BIN: RUNTIME_BIN,
    AMIRO_OUT_DIR: OUT_DIR,
    AMIRO_HOST: "127.0.0.1",
    AMIRO_PORT: String(port),
    AMIRO_TOKEN: token,
    AMIRO_NO_TELEMETRY: "1",
    AMIRO_NO_SCHEDULER: "1",
    AMIRO_ENV_FILE: path.join(dir, "none.env"),
    AMIRO_CONFIG: path.join(dir, "amiro.toml"),
    ...extraEnv,
  };
  if (!fs.existsSync(env.AMIRO_CONFIG)) fs.writeFileSync(env.AMIRO_CONFIG, "");
  const child = spawn(BACKEND_BIN, [], {
    cwd: dir,
    env,
    stdio: ["ignore", log, log],
    detached: true,
  });
  children.push({ child, socket: env.AMIRO_API_SOCKET });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 300; i += 1) {
    if (child.exitCode !== null)
      throw new Error(`${name} backend exited; see ${dir}/backend.log`);
    try {
      const res = await fetch(`${base}/health`, {
        headers: { "x-amiro-token": token },
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) break;
    } catch {}
    await sleep(200);
  }
  return { name, base, token, dir, home, runtimeHome };
}

function cleanup() {
  if (flag("keep")) return;
  for (const { child, socket } of children) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {}
    // The backend spawns the runtime bridge in its own process group; match
    // only this instance's socket so nothing else can be hit.
    spawnSync("pkill", ["-f", "--", `--api-socket ${socket}`]);
  }
  fs.rmSync(SOCKETS, { recursive: true, force: true });
}
process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));

async function api(inst, route, { method = "GET", body, session } = {}) {
  const headers = { "Content-Type": "application/json", "x-amiro-token": inst.token };
  headers.Authorization = `Bearer ${session ?? inst.session ?? inst.token}`;
  const res = await fetch(`${inst.base}${route}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${route}: ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

// ---------------------------------------------------------------------------
// Browser helpers
// ---------------------------------------------------------------------------

let browser;
const VIEWPORT = { width: 1440, height: 900 };

async function newContext(inst, { dark = false, video = false, session } = {}) {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: video ? 1 : 2,
    colorScheme: dark ? "dark" : "light",
    timezoneId: "Europe/London",
    locale: "en-GB",
    reducedMotion: "no-preference",
    ...(video
      ? { recordVideo: { dir: path.join(SCRATCH, "video"), size: VIEWPORT } }
      : {}),
  });
  await context.addInitScript(
    ({ session, dark }) => {
      if (session) localStorage.setItem("amiro.session-token", session);
      localStorage.setItem("app-theme-v2", dark ? "dark" : "light");
    },
    { session: session ?? inst.session, dark },
  );
  return context;
}

async function shot(page, name, opts = {}) {
  const file = path.join(ASSETS, `${name}.png`);
  await page.screenshot({ path: file, ...opts });
  console.log(`  wrote ${path.relative(ROOT, file)}`);
}

async function settle(page, ms = 900) {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(ms);
}

async function sendChat(page, text, waitFor) {
  const input = page
    .locator(
      '[data-testid="chat-input"] textarea, [data-testid="chat-input"] [contenteditable="true"], [data-testid="chat-input"] input',
    )
    .first();
  await input.waitFor({ timeout: 30000 });
  await input.click();
  await input.pressSequentially(text, { delay: 18 });
  await page.waitForTimeout(250);
  await page.locator('[data-testid="chat-send-button"]').click();
  try {
    await page.getByText(waitFor, { exact: false }).first().waitFor({ timeout: 60000 });
  } catch (error) {
    await page.screenshot({ path: path.join(SCRATCH, "error.png") });
    throw error;
  }
  // Wait for the stream to finish (the send button comes back).
  await page
    .locator('[data-testid="chat-send-button"]')
    .waitFor({ timeout: 60000 })
    .catch(() => {});
  await page.waitForTimeout(800);
}

// Converts a Playwright webm to an optimized GIF.
function toGif(webm, name, { start = 0, duration, width = 880, fps = 10 } = {}) {
  const out = path.join(ASSETS, `${name}.gif`);
  const palette = path.join(SCRATCH, `${name}-palette.png`);
  const trim = [
    ...(start ? ["-ss", String(start)] : []),
    ...(duration ? ["-t", String(duration)] : []),
  ];
  const filters = `fps=${fps},scale=${width}:-1:flags=lanczos`;
  const run = (a) => {
    const r = spawnSync(FFMPEG, ["-y", "-loglevel", "error", ...a], {
      stdio: "inherit",
    });
    if (r.status !== 0) throw new Error(`ffmpeg failed for ${name}`);
  };
  run([...trim, "-i", webm, "-vf", `${filters},palettegen=max_colors=96:stats_mode=diff`, palette]);
  run([
    ...trim,
    "-i",
    webm,
    "-i",
    palette,
    "-lavfi",
    `${filters}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
    "-loop",
    "0",
    out,
  ]);
  console.log(
    `  wrote ${path.relative(ROOT, out)} (${(fs.statSync(out).size / 1e6).toFixed(2)} MB)`,
  );
}

async function finishVideo(context, page) {
  const video = page.video();
  await context.close();
  return video ? await video.path() : null;
}

// ---------------------------------------------------------------------------
// Captures
// ---------------------------------------------------------------------------

async function captureOnboarding() {
  const inst = await startBackend("onboarding", PORTS.onboarding, {
    AMIRO_OPENAI_COMPAT_API_BASE: `http://127.0.0.1:${PORTS.stub}/v1`,
    OPENAI_COMPAT_API_KEY: "demo-key",
  });
  console.log("onboarding: stills");
  {
    const context = await newContext(inst, { session: "" });
    const page = await context.newPage();
    await page.goto(`${inst.base}/onboarding`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("onboarding-start").waitFor({ timeout: 30000 });
    await settle(page, 1500);
    await shot(page, "onboarding-welcome");
    await page.getByTestId("onboarding-start").click();
    await page.getByTestId("onboarding-name").waitFor();
    await page.getByTestId("onboarding-name").fill(OWNER.name);
    await page.getByTestId("onboarding-login").fill(OWNER.email);
    await page.getByTestId("onboarding-password").fill(OWNER.password);
    await page.getByTestId("onboarding-confirm").fill(OWNER.password);
    await settle(page, 600);
    await shot(page, "onboarding-account");
    await page.getByTestId("onboarding-create-account").click();
    await page.getByTestId("onboarding-agent-name").waitFor({ timeout: 30000 });
    await page.getByTestId("onboarding-agent-name").fill("Juno");
    await page.locator('[data-testid^="onboarding-shape-"]').nth(1).click();
    await page.locator('[data-testid^="onboarding-color-"]').nth(4).click();
    await settle(page, 1500);
    await shot(page, "onboarding-agent");
    await page.getByTestId("onboarding-agent-continue").click();
    await page.getByTestId("onboarding-provider-skip").waitFor({ timeout: 30000 });
    await settle(page, 800);
    await shot(page, "onboarding-provider");
    await page.getByTestId("onboarding-provider-skip").click();
    await page.getByTestId("onboarding-finish").waitFor({ timeout: 30000 });
    await settle(page, 1200);
    await shot(page, "onboarding-ready");
    await context.close();
  }
  await stopInstance(inst);

  console.log("onboarding: gif");
  const inst2 = await startBackend("onboarding-gif", PORTS.onboarding + 5, {
    AMIRO_OPENAI_COMPAT_API_BASE: `http://127.0.0.1:${PORTS.stub}/v1`,
    OPENAI_COMPAT_API_KEY: "demo-key",
  });
  const context = await newContext(inst2, { session: "", video: true });
  const page = await context.newPage();
  pageCreated.set(page, Date.now());
  await page.goto(`${inst2.base}/onboarding`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("onboarding-start").waitFor({ timeout: 30000 });
  await settle(page, 400);
  const t0 = Date.now();
  await page.waitForTimeout(900);
  await page.getByTestId("onboarding-start").click();
  await page.getByTestId("onboarding-name").waitFor();
  await page.getByTestId("onboarding-name").pressSequentially(OWNER.name, { delay: 40 });
  await page.getByTestId("onboarding-login").pressSequentially(OWNER.email, { delay: 20 });
  await page.getByTestId("onboarding-password").fill(OWNER.password);
  await page.getByTestId("onboarding-confirm").fill(OWNER.password);
  await page.waitForTimeout(300);
  await page.getByTestId("onboarding-create-account").click();
  await page.getByTestId("onboarding-agent-name").waitFor({ timeout: 30000 });
  await page.waitForTimeout(400);
  await page.getByTestId("onboarding-agent-name").fill("");
  await page.getByTestId("onboarding-agent-name").pressSequentially("Juno", { delay: 60 });
  const shapes = page.locator('[data-testid^="onboarding-shape-"]');
  const colors = page.locator('[data-testid^="onboarding-color-"]');
  for (const [s, c] of [[2, 2], [3, 6], [1, 4]]) {
    await shapes.nth(s).click();
    await page.waitForTimeout(450);
    await colors.nth(c).click();
    await page.waitForTimeout(550);
  }
  await page.getByTestId("onboarding-agent-continue").click();
  await page.getByTestId("onboarding-provider-skip").waitFor({ timeout: 30000 });
  await page.waitForTimeout(900);
  await page.getByTestId("onboarding-provider-skip").click();
  await page.getByTestId("onboarding-finish").waitFor({ timeout: 30000 });
  await page.waitForTimeout(1600);
  const lead = (t0 - pageCreated.get(page)) / 1000;
  const webm = await finishVideo(context, page);
  toGif(webm, "demo-onboarding", { start: Math.max(0, lead), duration: 12 });
  await stopInstance(inst2);
}


async function stopInstance(inst) {
  const entry = children.find((c) => c.socket === path.join(SOCKETS, `${inst.name}.sock`));
  if (!entry || flag("keep")) return;
  try {
    process.kill(-entry.child.pid, "SIGTERM");
  } catch {}
  spawnSync("pkill", ["-f", "--", `--api-socket ${entry.socket}`]);
}

async function startMain() {
  const inst = await startBackend(
    "main",
    PORTS.main,
    {
      AMIRO_SKIP_ONBOARDING: "1",
      AMIRO_OWNER_EMAIL: OWNER.email,
      AMIRO_OWNER_PASSWORD: OWNER.password,
      AMIRO_OWNER_NAME: OWNER.name,
      AMIRO_OWNER_TIMEZONE: "Europe/London",
      AMIRO_AGENT_NAME: "Juno",
      AMIRO_AGENT_AVATAR: "sprout",
      AMIRO_AGENT_COLOR: "teal",
      AMIRO_OPENAI_COMPAT_API_BASE: `http://127.0.0.1:${PORTS.stub}/v1`,
      OPENAI_COMPAT_API_KEY: "demo-key",
      AMIRO_DEFAULT_MODEL: "openai-compatible:demo-model",
      AMIRO_PINNED_MODELS: "openai-compatible:demo-model",
      AMIRO_TOOL_PROFILE: "none",
      // Schedule mutations need the scheduler lock; nothing is due while the
      // capture runs, so no schedule fires.
      AMIRO_NO_SCHEDULER: "0",
    },
    ({ runtimeHome }) => {
      // Connectors shown on the Connectors page. Their secrets are vault
      // placeholders that are never filled, so nothing is ever dialled.
      fs.writeFileSync(
        path.join(runtimeHome, "mcp.json"),
        JSON.stringify(
          {
            servers: {
              linear: {
                url: "https://mcp.linear.app/mcp",
                transport: "http",
                headers: {
                  Authorization: "Bearer ${AMIRO_CRED_MCP_LINEAR_AUTHORIZATION}",
                },
              },
              github: {
                url: "https://api.githubcopilot.com/mcp/",
                transport: "http",
                headers: {
                  Authorization: "Bearer ${AMIRO_CRED_MCP_GITHUB_AUTHORIZATION}",
                },
              },
              notion: {
                url: "https://mcp.notion.com/mcp",
                transport: "http",
                headers: {
                  Authorization: "Bearer ${AMIRO_CRED_MCP_NOTION_AUTHORIZATION}",
                },
              },
            },
          },
          null,
          2,
        ),
      );
    },
  );
  const login = await fetch(`${inst.base}/api/auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-amiro-token": inst.token,
    },
    body: JSON.stringify({ email: OWNER.email, password: OWNER.password }),
  });
  if (!login.ok) throw new Error(`login failed: ${login.status} ${await login.text()}`);
  inst.session = (await login.json()).token;
  return inst;
}

async function seedChats(inst) {
  console.log("main: seeding chats");
  const context = await newContext(inst);
  const page = await context.newPage();
  for (const [text, reply] of [
    ["Summarize the article on sleep I saved yesterday", "consistency beats duration"],
    ["What's a good 20-minute dinner with chickpeas?", "chickpea and spinach"],
    ["Draft a reply to Sam about the Q3 budget", "Here's a draft"],
  ]) {
    await page.goto(`${inst.base}/`, { waitUntil: "domcontentloaded" });
    await sendChat(page, text, reply);
  }
  await context.close();
}

const PLAN_PROMPT =
  "I've got the launch on Thursday and three interviews this week. Help me plan it.";

async function captureChat(inst) {
  // The GIF goes first: it creates the planning thread the stills reopen,
  // so the sidebar never shows the same chat twice.
  console.log("main: chat gif");
  let threadUrl;
  {
    const context = await newContext(inst, { video: true });
    const page = await context.newPage();
    pageCreated.set(page, Date.now());
    await page.goto(`${inst.base}/`, { waitUntil: "domcontentloaded" });
    await settle(page, 600);
    const t0 = Date.now();
    await sendChat(page, PLAN_PROMPT, "Two things I'd move");
    await page.waitForTimeout(1200);
    threadUrl = page.url();
    const lead = (t0 - pageCreated.get(page)) / 1000;
    const webm = await finishVideo(context, page);
    toGif(webm, "demo-chat", { start: lead, duration: 10 });
  }

  console.log("main: chat stills");
  for (const dark of [true, false]) {
    const context = await newContext(inst, { dark });
    const page = await context.newPage();
    await page.goto(threadUrl, { waitUntil: "domcontentloaded" });
    await page.getByText("Two things I'd move").first().waitFor({ timeout: 30000 });
    await settle(page, 1200);
    await shot(page, dark ? "hero-chat-dark" : "chat-plan-light");
    await context.close();
  }
}

async function captureVoice(inst) {
  console.log("main: voice room");
  const context = await newContext(inst);
  await context.route("**/api/live-voice/preflight", (route) =>
    route.fulfill({
      json: {
        ready: true,
        stt: { provider: "elevenlabs", configured: true, model: "scribe_v1" },
        tts: {
          provider: "elevenlabs",
          configured: true,
          model: "eleven_flash_v2_5",
          voiceId: "EXAVITQu4vr4xnSDxMaL",
        },
      },
    }),
  );
  await context.route("**/api/live-voice/ticket", (route) =>
    route.fulfill({ json: { ticket: "demo", expiresInMs: 60000 } }),
  );
  const page = await context.newPage();
  await page.routeWebSocket(/\/api\/live-voice/, (ws) => {
    ws.onMessage((message) => {
      if (typeof message === "string" && message.includes('"start"')) {
        ws.send(
          JSON.stringify({
            type: "ready",
            seq: 1,
            sessionId: "demo",
            turnDetection: "server_vad",
            tts: {
              provider: "elevenlabs",
              voiceId: "EXAVITQu4vr4xnSDxMaL",
              model: "eleven_flash_v2_5",
              sampleRate: 24000,
            },
          }),
        );
      }
    });
  });
  await page.goto(`${inst.base}/`, { waitUntil: "domcontentloaded" });
  await settle(page, 1000);
  await page.getByTestId("composer-voice-mode-button").click();
  await page.getByTestId("voice-room").waitFor({ timeout: 15000 });
  await page.waitForTimeout(2500);
  await shot(page, "voice-room");
  await context.close();
}

async function capturePages(inst) {
  console.log("main: pages");
  const context = await newContext(inst);
  const page = await context.newPage();
  for (const [route, name, wait] of [
    ["/agent", "agent", 1800],
    ["/connectors", "connectors", 1800],
    ["/agent/superpowers", "superpowers", 1500],
    ["/agent/workspace", "workspace", 1500],
  ]) {
    if (ONLY && !ONLY.includes(name) && !ONLY.includes("pages")) continue;
    await page.goto(`${inst.base}${route}`, { waitUntil: "domcontentloaded" });
    await settle(page, wait);
    if (name === "workspace") {
      const soul = page.getByText("SOUL.md", { exact: false }).first();
      if (await soul.count()) {
        await soul.click().catch(() => {});
        await settle(page, 900);
      }
    }
    await shot(page, name);
  }
  await context.close();
}

async function captureSchedules(inst) {
  console.log("main: schedules");
  await api(inst, "/api/schedules", {
    method: "POST",
    body: {
      name: "Weekly review",
      prompt:
        "Read this week's journal and NOW.md, then write a short review: what shipped, what slipped, and the three priorities for next week. Update NOW.md.",
      mode: "agent",
      timezone: "Europe/London",
      schedule: { kind: "cron", expression: "0 16 * * 5" },
    },
  });
  await api(inst, "/api/schedules", {
    method: "POST",
    body: {
      name: "Send the launch checklist",
      prompt: "Reminder: send the launch checklist to the team.",
      mode: "notify",
      timezone: "Europe/London",
      schedule: { kind: "cron", expression: "0 17 * * 3" },
    },
  });

  const context = await newContext(inst, { video: true });
  const page = await context.newPage();
  pageCreated.set(page, Date.now());
  await page.goto(`${inst.base}/schedules`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Schedules", exact: true }).waitFor();
  await settle(page, 800);
  const t0 = Date.now();
  await page.waitForTimeout(800);
  const recipe = page.locator('[data-testid^="schedule-recipe-"]').first();
  await recipe.hover();
  await page.waitForTimeout(500);
  await recipe.click();
  await page.getByTestId("schedule-dialog-save").waitFor({ timeout: 15000 });
  await page.waitForTimeout(2200);
  await page.getByTestId("schedule-dialog-save").click();
  await page.waitForTimeout(2500);
  const lead = (t0 - pageCreated.get(page)) / 1000;
  const webm = await finishVideo(context, page);
  toGif(webm, "demo-schedules", { start: lead, duration: 8 });

  const still = await newContext(inst);
  const p2 = await still.newPage();
  await p2.goto(`${inst.base}/schedules`, { waitUntil: "domcontentloaded" });
  await p2.getByRole("heading", { name: "Schedules", exact: true }).waitFor();
  await settle(p2, 1200);
  const row = p2.locator('[data-testid^="schedule-row-select-"]').first();
  if (await row.count()) {
    await row.click().catch(() => {});
    await settle(p2, 900);
  }
  await shot(p2, "schedules");
  await still.close();
}

// ---------------------------------------------------------------------------

const stub = await startStub(PORTS.stub);
browser = await chromium.launch({
  executablePath: BROWSER,
  headless: true,
  args: [
    "--no-sandbox",
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
});
try {
  if (wants("onboarding")) await captureOnboarding();
  const mainNeeded = [
    "chat",
    "voice",
    "pages",
    "agent",
    "connectors",
    "superpowers",
    "workspace",
    "schedules",
  ].some(wants);
  if (mainNeeded) {
    const inst = await startMain();
    if (wants("chat")) {
      await seedChats(inst);
      await captureChat(inst);
    }
    await capturePages(inst);
    if (wants("schedules")) await captureSchedules(inst);
    if (wants("voice")) await captureVoice(inst);
  }
} finally {
  await browser.close();
  stub.close();
}
console.log("done");
process.exit(0);
