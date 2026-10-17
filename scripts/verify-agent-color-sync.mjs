import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "@playwright/test";

const base = process.env.AMIRO_TEST_URL || "http://127.0.0.1:8788";
const credentials = JSON.parse(await readFile(
  process.env.AMIRO_TEST_CREDENTIALS || "/root/.amiro-preview/admin-initial-password",
  "utf8",
));
const login = await fetch(`${base}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(credentials),
});
assert.equal(login.status, 200);
const { token } = await login.json();
const headers = { Authorization: `Bearer ${token}`, "content-type": "application/json" };
async function identity() {
  const response = await fetch(`${base}/api/agent/identity`, { headers });
  assert.equal(response.status, 200);
  return response.json();
}
const original = await identity();
const mapping = {
  green: "zen-garden", orange: "orange", pink: "pink", purple: "ultraviolet",
  teal: "misty-harbor", yellow: "honey", indigo: "space-odyssey", cobalt: "blue", black: "midnight",
};
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--no-sandbox"] });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
  await context.addInitScript(value => localStorage.setItem("amiro.session-token", value), token);
  const page = await context.newPage();
  await page.goto(`${base}/agent`, { waitUntil: "networkidle" });
  await page.getByTestId("agent-hero-avatar-button").waitFor();
  for (const [color, theme] of Object.entries(mapping)) {
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.getByTestId("sidebar-user-button").click();
    const trigger = page.getByRole("menuitem", { name: /theme/i });
    await trigger.hover();
    await trigger.click();
    const label = color[0].toUpperCase() + color.slice(1);
    await page.getByRole("menuitemcheckbox", { name: label, exact: true }).click();
    await page.waitForFunction(expected => document.body.dataset.theme === expected, theme);
    await page.waitForTimeout(350);
    const saved = await identity();
    assert.equal(saved.traits.color, color, `Sidebar ${color} must persist agent color`);
    assert.equal(saved.traits.bodyShape, original.traits.bodyShape, "Sidebar must preserve agent form");
    assert.equal(saved.traits.eyeStyle, original.traits.eyeStyle, "Sidebar must preserve eyes");
    assert.equal(saved.name, original.name, "Sidebar must preserve name");
    console.log(`PASS sidebar ${color} -> ${theme} and saved agent color`);
  }
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForFunction(() => document.body.dataset.theme === "midnight");
  await page.getByTestId("agent-hero-avatar-button").click();
  assert.equal((await page.getByTestId("agent-color-value").textContent()).trim(), "Black");
  await page.getByTestId("agent-next-color").click();
  await page.getByTestId("agent-customizer-save").click();
  await page.getByTestId("agent-customizer-modal").waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.body.dataset.theme === "zen-garden");
  assert.equal((await identity()).traits.color, "green");
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForFunction(() => document.body.dataset.theme === "zen-garden");
  console.log("PASS agent -> sidebar, reload persistence, all nine sidebar selections");
} finally {
  const response = await fetch(`${base}/api/agent/identity`, {
    method: "PUT", headers,
    body: JSON.stringify({
      name: original.name, handle: original.handle, tagline: original.tagline,
      traits: original.traits, accentHex: original.accentHex,
      customImageUrl: original.customImageUrl, sliders: original.sliders,
    }),
  });
  assert.equal(response.status, 200, "Restore original identity");
  await browser.close();
}
