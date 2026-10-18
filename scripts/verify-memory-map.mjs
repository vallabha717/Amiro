import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { spawn } from "node:child_process";
import { chromium } from "@playwright/test";

// Isolated runtime fixture. Never writes to production memory or authenticates
// to an external provider. Uses the actual built Rust API and production out/.
const root = await mkdtemp(
  path.join(process.env.JCODE_SCRATCH_DIR || os.homedir(), "amiro-memory-map-"),
);
const home = path.join(root, "home");
const runtime = path.join(root, "runtime");
await mkdir(home);
await mkdir(path.join(runtime, "memory"), { recursive: true });
const categories = ["fact", "preference", "entity", "correction", "unknown"];
const memories = Object.fromEntries(
  Array.from({ length: 85 }, (_, index) => {
    const id = `map-memory-${String(index).padStart(3, "0")}`;
    return [
      id,
      {
        id,
        content:
          index === 84
            ? "Unique searchable memory beyond the initial map window"
            : `Memory ${index}: ${["Amiro serves the production build through Rust.", "Prefers clear project notes and thoughtful interfaces.", "The project team includes designers and engineers.", "Use the new deployment instructions, not the old ones.", "An uncategorized note with useful context."][index % 5]}`,
        category: categories[index % 5],
        tags: index < 8 ? ["project", "interface"] : [],
        active: index !== 4,
        created_at: "2026-10-01T09:00:00Z",
        updated_at: "2026-10-18T12:00:00Z",
      },
    ];
  }),
);
await writeFile(
  path.join(runtime, "memory/global.json"),
  JSON.stringify({
    memories,
    edges: {
      "map-memory-000": [
        { target: "map-memory-001", kind: "related" },
        "map-memory-002",
      ],
    },
  }),
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
    AMIRO_RUNTIME_HOME: runtime,
    AMIRO_RUNTIME_DIR: runtime,
    AMIRO_API_SOCKET: path.join(runtime, "amiro-api.sock"),
    AMIRO_RUNTIME_BIN: path.resolve("runtime/target/debug/amiro-runtime"),
    AMIRO_OUT_DIR: path.resolve(process.env.MEMORY_MAP_OUT_DIR || "out"),
    AMIRO_HOST: "127.0.0.1",
    AMIRO_PORT: String(port),
    AMIRO_OWNER_EMAIL: "map@amiro.test",
    AMIRO_OWNER_PASSWORD: "memory-map-local-acceptance-1",
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
      email: "map@amiro.test",
      password: "memory-map-local-acceptance-1",
    }),
  });
  assert.equal(login.status, 200);
  const { token } = await login.json();
  const response = await fetch(base + "/api/agent/memory", {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(
    data.memories.length,
    84,
    "Runtime API omits the inactive fixture",
  );
  assert.equal(data.readOnly, true);
  assert(data.edges.some((edge) => edge.kind === "explicit"));
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
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
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(base + "/agent/memory", { waitUntil: "networkidle" });
    await page.getByTestId("memory-map").waitFor();
    assert.equal(
      await page
        .getByRole("button", { name: "Map", exact: true })
        .getAttribute("aria-pressed"),
      "true",
    );
    assert.equal(await page.getByTestId("memory-card").count(), 0);
    assert.equal(await page.getByTestId("memory-create-button").count(), 0);
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth + 2,
      ),
      false,
    );
    await page.screenshot({
      path: path.join(root, `map-${viewport.width}.png`),
      fullPage: true,
    });
    // Detailed map controls and SVG geometry checks are below once the map is
    // mounted. Use real UI controls rather than invoking component internals.
    const map = page.getByTestId("memory-map");
    assert.equal(await page.getByTestId("memory-map-node").count(), 20);
    assert.equal(await page.getByTestId("memory-map-minimap").count(), 1);
    await page.getByTestId("memory-map-load-more").click();
    assert.equal(await page.getByTestId("memory-map-node").count(), 60);
    await page.getByTestId("memory-map-load-more").click();
    assert.equal(await page.getByTestId("memory-map-node").count(), 20);
    await page.getByTestId("memory-map-cluster-correction").click();
    await map
      .getByRole("button", { name: /Fit|Reset view/i })
      .first()
      .click();
    const svg = page.getByTestId("memory-map-svg");
    const transformBefore = await svg
      .locator(":scope > g")
      .getAttribute("transform");
    await page.getByTestId("memory-map-viewport").scrollIntoViewIfNeeded();
    const box = await page.getByTestId("memory-map-viewport").boundingBox();
    await page.mouse.move(box.x + 15, box.y + 15);
    await page.mouse.down();
    await page.mouse.move(box.x + 80, box.y + 50, { steps: 5 });
    await page.mouse.up();
    assert.notEqual(
      await svg.locator(":scope > g").getAttribute("transform"),
      transformBefore,
    );
    assert.equal(
      await page.getByRole("dialog", { name: "Memory detail" }).count(),
      0,
      "Pan never opens a memory",
    );
    await map
      .getByRole("button", { name: /Fit|Reset view/i })
      .first()
      .click();
    await map.getByRole("button", { name: /Zoom in/i }).click();
    await map.getByRole("button", { name: /Zoom out/i }).click();
    await map
      .getByRole("button", { name: /Fit|Reset view/i })
      .first()
      .click();
    await page
      .getByTestId("memory-search-input")
      .fill("Unique searchable memory");
    await page.getByTestId("memory-map-node").first().waitFor();
    await page.getByTestId("memory-map-node").first().click();
    await page.getByRole("dialog", { name: "Memory detail" }).waitFor();
    assert(
      (
        await page.getByRole("dialog", { name: "Memory detail" }).innerText()
      ).includes("beyond the initial map window"),
    );
    await page.keyboard.press("Escape");
    await page
      .getByRole("dialog", { name: "Memory detail" })
      .waitFor({ state: "hidden" });
    await page.getByTestId("memory-map-focus").click();
    assert.equal(await page.getByTestId("memory-map-node").count(), 1);
    await page.getByTestId("memory-map-focus").click();
    await page.getByTestId("memory-search-input").fill("no-matches-7ca24");
    await page
      .getByText(/No memories match/i)
      .first()
      .waitFor();
    await page.getByTestId("memory-search-input").fill("");
    await page.getByRole("button", { name: "Cards", exact: true }).click();
    await page.getByTestId("memory-card").first().waitFor();
    assert.equal(await page.getByTestId("memory-card").count(), 24);
    await page.screenshot({
      path: path.join(root, `cards-${viewport.width}.png`),
      fullPage: true,
    });
    await page.getByTestId("memory-load-more").click();
    assert.equal(await page.getByTestId("memory-card").count(), 48);
    await page.getByTestId("memory-card").first().click();
    await page.getByRole("dialog", { name: "Memory detail" }).waitFor();
    await page.waitForFunction(() =>
      document.activeElement?.closest('[role="dialog"]'),
    );
    await page.keyboard.press("Escape");
    await page
      .getByRole("dialog", { name: "Memory detail" })
      .waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Map", exact: true }).click();
    await page.getByTestId("memory-map").waitFor();
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await page.screenshot({
      path: path.join(root, `map-dark-${viewport.width}.png`),
      fullPage: true,
    });
    assert.deepEqual(errors, []);
    console.log(
      `PASS ${viewport.width}px real API: default map, zoom/fit, search beyond window, node detail/Escape, empty search, card pagination/detail, map remount, light/dark, no overflow or JS errors`,
    );
    await context.close();
  }
  console.log(`MEMORY_MAP_ACCEPTANCE_OK evidence=${root}`);
} finally {
  await browser?.close();
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {}
}
