// Browser acceptance for the native Amiro stack.
//
// Drives the production static export served by backend/src/main.rs, with the
// owned runtime bridge on a local OpenAI-compatible stub. Verifies the product
// requirements that only a browser can prove: visible arrow controls, the black
// plush mascot (filter + blend, not a flat silhouette), theme persistence, a
// read-only workspace that never prints host paths, narrow-viewport layout,
// reduced motion, and a real streamed chat reply.
//
// Started by scripts/start-native-ui-check.sh; also runnable directly with
// AMIRO_UI_URL and AMIRO_UI_TOKEN in the environment.
import fs from "node:fs";
import { chromium } from "@playwright/test";

const BASE = process.env.AMIRO_UI_URL || "http://127.0.0.1:38952";
const tokenFile = process.env.AMIRO_UI_TOKEN_FILE;
const TOKEN =
  process.env.AMIRO_UI_TOKEN ||
  (tokenFile ? fs.readFileSync(tokenFile, "utf8").trim() : "");
if (!TOKEN) {
  console.error("AMIRO_UI_TOKEN or AMIRO_UI_TOKEN_FILE is required");
  process.exit(2);
}
const SHOT_DIR = process.env.AMIRO_UI_SHOT_DIR || "backend/target/ui-check";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${detail ? ` :: ${detail}` : ""}`,
  );
}

const browser = await chromium.launch({
  executablePath: process.env.AMIRO_UI_BROWSER || "/usr/bin/google-chrome",
  headless: true,
});
const context = await browser.newContext({
  viewport: { width: 1360, height: 900 },
});
await context.addInitScript((token) => {
  window.localStorage.setItem("amiro.session-token", token);
}, TOKEN);
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(String(error)));

// --- Customizer: visible arrow controls -------------------------------------
await page.goto(`${BASE}/agent/`, { waitUntil: "domcontentloaded" });
const trigger = page.locator('[data-testid="agent-customize-trigger"]');
await trigger.waitFor({ state: "visible", timeout: 30000 });
await trigger.click();
const modal = page.locator('[data-testid="agent-customizer-modal"]');
await modal.waitFor({ state: "visible", timeout: 30000 });

for (const id of [
  "agent-prev-theme",
  "agent-next-theme",
  "agent-prev-body-shape",
]) {
  const button = page.locator(`[data-testid="${id}"]`);
  const box = await button.boundingBox();
  const visible = await button.isVisible();
  check(
    `visible arrow control ${id}`,
    visible && !!box && box.width >= 24 && box.height >= 24,
    box ? `${Math.round(box.width)}x${Math.round(box.height)}` : "no box",
  );
}

const themeBefore = (
  await page.locator('[data-testid="agent-theme-value"]').innerText()
).trim();
await page.locator('[data-testid="agent-next-theme"]').click();
await page.waitForTimeout(300);
const themeAfter = (
  await page.locator('[data-testid="agent-theme-value"]').innerText()
).trim();
check(
  "next arrow changes the theme",
  themeBefore !== themeAfter,
  `${themeBefore} -> ${themeAfter}`,
);

// --- Black plush mascot on Midnight ----------------------------------------
let themeNow = (
  await page.locator('[data-testid="agent-theme-value"]').innerText()
).trim();
for (let i = 0; i < 24 && themeNow.toLowerCase() !== "midnight"; i += 1) {
  await page.locator('[data-testid="agent-next-theme"]').click();
  await page.waitForTimeout(120);
  themeNow = (
    await page.locator('[data-testid="agent-theme-value"]').innerText()
  ).trim();
}
check(
  "midnight theme reachable with the arrow",
  themeNow.toLowerCase() === "midnight",
  themeNow,
);
check(
  "mascot carries the black plush tint",
  (await page.locator('[data-agent-tint="black"]').count()) > 0,
);
const previewSvg = await page
  .locator('[data-testid="agent-customizer-modal"] svg[data-agent-tint]')
  .first()
  .evaluate((node) => {
    const gamma = node.querySelector('feFuncR[type="gamma"]');
    const sprite = node.querySelector("image[filter]");
    const overlay = Array.from(node.querySelectorAll("rect,use,g")).find(
      (el) => getComputedStyle(el).mixBlendMode === "color",
    );
    return {
      tint: node.getAttribute("data-agent-tint"),
      gammaExponent: gamma?.getAttribute("exponent") ?? null,
      spriteFilter: sprite?.getAttribute("filter") ?? null,
      blend: overlay ? getComputedStyle(overlay).mixBlendMode : null,
      imageHref:
        node.querySelector("image")?.getAttribute("href")?.slice(0, 24) ?? null,
    };
  });
check(
  "black tint darkens the plush sprite without flattening it",
  previewSvg.tint === "black" &&
    previewSvg.gammaExponent === "4" &&
    /^url\(#/.test(previewSvg.spriteFilter || "") &&
    previewSvg.blend === "color" &&
    !!previewSvg.imageHref,
  JSON.stringify(previewSvg),
);

// --- Save and reload --------------------------------------------------------
await page.locator('[data-testid="agent-customizer-save"]').click();
await page.waitForTimeout(2000);
check(
  "save closes the customizer",
  !(await page
    .locator('[data-testid="agent-customizer-modal"]')
    .isVisible()
    .catch(() => false)),
);
check(
  "sidebar mascot is black after saving Midnight",
  (await page.locator('[data-agent-tint="black"]').count()) > 0,
);
const bodyTheme = await page.evaluate(() =>
  document.body.getAttribute("data-theme"),
);
check(
  "midnight theme is applied to the app",
  bodyTheme === "midnight",
  String(bodyTheme),
);

await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(1200);
const reloadTheme = await page.evaluate(() =>
  document.body.getAttribute("data-theme"),
);
check(
  "theme survives a reload",
  reloadTheme === "midnight",
  String(reloadTheme),
);
check(
  "black mascot tint survives a reload",
  (await page.locator('[data-agent-tint="black"]').count()) > 0,
);

// --- Workspace: read-only, no absolute host paths --------------------------
await page.goto(`${BASE}/agent/workspace/`, { waitUntil: "domcontentloaded" });
await page
  .locator('[data-testid="workspace-root-tabs"]')
  .waitFor({ timeout: 30000 });
const workspaceText = await page.locator("body").innerText();
check(
  "workspace view exposes no absolute host paths",
  !/(\/root\/|\/home\/|\\Users\\|[A-Za-z]:\\\\)/.test(workspaceText),
  workspaceText.match(/(\/root\/[^\s]*|\/home\/[^\s]*)/)?.[0] || "none",
);
check(
  "workspace view says it is read-only",
  /read[- ]only|view[- ]only/i.test(workspaceText),
);
check("workspace view uses Amiro branding", !/jcode/i.test(workspaceText));

// --- Narrow viewport -------------------------------------------------------
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(500);
const overflow = await page.evaluate(() => ({
  scroll: document.documentElement.scrollWidth,
  client: document.documentElement.clientWidth,
}));
check(
  "narrow viewport has no horizontal overflow",
  overflow.scroll <= overflow.client + 1,
  `${overflow.scroll} vs ${overflow.client}`,
);

// --- Reduced motion --------------------------------------------------------
await page.emulateMedia({ reducedMotion: "reduce" });
await page.setViewportSize({ width: 1360, height: 900 });
await page.goto(`${BASE}/agent/`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(800);
check(
  "agent page renders with reduced motion",
  await page.locator("body").isVisible(),
);

// --- Real chat turn through the native backend -----------------------------
await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
const input = page
  .locator(
    '[data-testid="chat-input"] textarea, [data-testid="chat-input"] [contenteditable="true"], [data-testid="chat-input"] input',
  )
  .first();
await input.waitFor({ timeout: 30000 });
await input.click();
await input.fill("say hello");
await page.locator('[data-testid="chat-send-button"]').click();
let reply = "";
for (let i = 0; i < 60; i += 1) {
  await page.waitForTimeout(500);
  const text = await page.locator("body").innerText();
  if (text.includes("Hello from the local stub provider")) {
    reply = "Hello from the local stub provider";
    break;
  }
  if (/An error occurred|errorText/i.test(text) && i > 10) break;
}
check(
  "chat renders the runtime's streamed reply",
  reply !== "",
  reply || "no reply seen",
);
check(
  "chat did not surface an error",
  !/An error occurred|errorText|ECONN|not running/i.test(
    await page.locator("body").innerText(),
  ),
);

check(
  "no uncaught page errors",
  errors.length === 0,
  errors.slice(0, 3).join(" | "),
);

fs.mkdirSync(SHOT_DIR, { recursive: true });
await page.screenshot({ path: `${SHOT_DIR}/chat.png` });
await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} checks passed`,
);
if (failed.length) {
  console.log("FAILED:", failed.map((r) => r.name).join(", "));
  process.exit(1);
}
