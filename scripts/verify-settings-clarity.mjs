import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";

const base = process.env.AMIRO_TEST_URL || "http://127.0.0.1:3000";
const phase = process.env.AMIRO_SETTINGS_PHASE || "after";
const output = path.join(
  process.env.JCODE_SCRATCH_DIR || os.homedir(),
  `amiro-settings-${phase}`,
);
await mkdir(output, { recursive: true });
let token = process.env.AMIRO_TEST_TOKEN;
if (!token) {
  const sessions = JSON.parse(
    await readFile(path.join(os.homedir(), ".amiro/sessions.json"), "utf8"),
  );
  for (const candidate of Object.keys(sessions.sessions || {})) {
    const response = await fetch(`${base}/api/auth/session`, {
      headers: { Authorization: `Bearer ${candidate}` },
    });
    if (response.ok && (await response.json()).role === "admin") {
      token = candidate;
      break;
    }
  }
}
assert(token, "An existing admin session is required");
const headers = { Authorization: `Bearer ${token}` };
for (const route of [
  "/api/credentials",
  "/api/agent/workspace",
  "/api/agent/memory",
  "/api/skills",
]) {
  const response = await fetch(base + route, { headers });
  assert.equal(response.status, 200, `${route} public authenticated interface`);
  console.log(`PASS authenticated ${route} 200`);
}
const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox"],
});
const observations = [];
try {
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
  ]) {
    const context = await browser.newContext({
      viewport,
      reducedMotion: "reduce",
    });
    await context.addInitScript(
      (value) => localStorage.setItem("amiro.session-token", value),
      token,
    );
    const page = await context.newPage();
    for (const [name, route, ready] of [
      ["credentials", "/admin/credentials", "credentials-add-button"],
      ["workspace", "/agent/workspace", "workspace-search-input"],
      ["memory", "/agent/memory", "memory-search-input"],
      ["superpowers", "/agent/superpowers", "superpowers-search-input"],
    ]) {
      const errors = [];
      const onError = (error) => errors.push(error.message);
      page.on("pageerror", onError);
      await page.goto(base + route, { waitUntil: "networkidle" });
      await page.getByTestId(ready).waitFor({ timeout: 30000 });
      await page.waitForTimeout(300);
      const metrics = await page.evaluate(() => {
        const main = document.querySelector("main") || document.body;
        const visible = (element) =>
          element.getClientRects().length &&
          getComputedStyle(element).visibility !== "hidden";
        return {
          words: (main.innerText || "").split(/\s+/).filter(Boolean).length,
          buttons: [...main.querySelectorAll("button")].filter(visible).length,
          canvases: [...main.querySelectorAll("canvas")].filter(visible).length,
          overflow:
            document.documentElement.scrollWidth > window.innerWidth + 2,
        };
      });
      observations.push({ name, viewport: viewport.width, ...metrics });
      assert.equal(errors.length, 0, `${name} has no browser runtime errors`);
      if (phase === "after")
        assert.equal(
          metrics.overflow,
          false,
          `${name} fits ${viewport.width}px viewport`,
        );
      await page.screenshot({
        path: path.join(output, `${name}-${viewport.width}.png`),
        fullPage: true,
      });
      if (phase === "after" && name === "credentials") {
        assert.equal(
          await page
            .getByTestId("credentials-agent-guide-card")
            .isVisible()
            .catch(() => false),
          false,
          "No upfront security architecture guide",
        );
        await page.getByTestId("credentials-add-button").click();
        await page.getByTestId("credentials-add-dialog").waitFor();
        await page.keyboard.press("Escape");
        await page
          .getByTestId("credentials-add-dialog")
          .waitFor({ state: "hidden" });
      }
      if (phase === "after" && name === "memory") {
        assert.equal(
          await page.getByTestId("memory-constellation-canvas").count(),
          0,
          "Memory starts with readable entries, not a map",
        );
        await page
          .getByTestId("memory-search-input")
          .fill("no-match-settings-clarity-7c2b");
        await page.waitForTimeout(100);
        await page.getByTestId("memory-search-input").fill("");
        if (await page.getByTestId("memory-create-button").count()) {
          await page.getByTestId("memory-create-button").click();
          await page.getByTestId("memory-create-modal").waitFor();
          await page.keyboard.press("Escape");
        } else {
          console.log(
            "PASS native memory remains read-only, no misleading create action",
          );
        }
      }
      if (phase === "after" && name === "superpowers") {
        assert.equal(
          await page.getByTestId("superpowers-constellation-canvas").count(),
          0,
          "Superpowers starts with readable skills",
        );
        const cards = page.getByTestId("skill-card");
        const initial = await cards.count();
        if (!initial)
          console.log(
            "PASS current runtime has no skills, checking real empty state",
          );
        await page
          .getByTestId("superpowers-search-input")
          .fill("no-match-settings-clarity-7c2b");
        assert.equal(await cards.count(), 0, "Skill search filters real rows");
        await page.getByTestId("superpowers-search-input").fill("");
        assert.equal(
          await cards.count(),
          initial,
          "Clearing search restores skills",
        );
      }
      page.off("pageerror", onError);
      console.log(
        `PASS ${phase} ${name} ${viewport.width}px ${JSON.stringify(metrics)}`,
      );
    }
    await context.close();
  }
  await writeFile(
    path.join(output, "observations.json"),
    JSON.stringify(observations, null, 2),
  );
  console.log(`PASS screenshots and observations saved to ${output}`);
} finally {
  await browser.close();
}
