import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";

const base = process.env.AMIRO_TEST_URL || "http://127.0.0.1:3000";
const home = process.env.AMIRO_TEST_HOME || path.join(os.homedir(), ".amiro");
const users = JSON.parse(
  await readFile(path.join(home, "users.json"), "utf8"),
).users;
const sessions = JSON.parse(
  await readFile(path.join(home, "sessions.json"), "utf8"),
).sessions;
const admin = users.find((u) => u.email === "admin@local");
const token = Object.keys(sessions).find(
  (k) => sessions[k].userId === admin?.id,
);
assert(token, "An existing administrator session is required");
const headers = { Authorization: `Bearer ${token}` };
const api = async (route, options = {}) => {
  const response = await fetch(`${base}${route}`, { ...options, headers });
  assert.equal(response.status, 200, `${route} status`);
  return response.json();
};
const providers = await api("/api/search/providers");
assert.equal(providers.filter((p) => p.configured).length, 3);
for (const kind of ["inference-provider-native", "duckduckgo", "bing"]) {
  assert(
    providers.some((p) => p.provider === kind && p.configured),
    `${kind} preconfigured`,
  );
}
const original = providers.find((p) => p.isActive);
assert.equal(original.provider, "inference-provider-native");
const catalog = await api("/api/search/catalog");
assert(!JSON.stringify(catalog).toLowerCase().includes("vellum"));
const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox"],
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
});
await context.addInitScript(
  (value) => localStorage.setItem("amiro.session-token", value),
  token,
);
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
  await page.goto(`${base}/admin/search`);
  await page.getByTestId("search-provider-card").first().waitFor();
  assert.equal(await page.getByTestId("search-provider-card").count(), 3);
  const native = page.locator(`[data-provider-id="${original.id}"]`);
  assert.match(await native.innerText(), /Default/);
  const bing = providers.find((p) => p.provider === "bing");
  await page
    .getByRole("button", { name: `Set ${bing.name} as default`, exact: true })
    .click();
  await page.waitForFunction(async () => {
    const token = localStorage.getItem("amiro.session-token");
    const r = await fetch("/api/search/active", {
      headers: { Authorization: `Bearer ${token}` },
    });
    return (await r.json()).provider === "bing";
  });
  assert.equal((await api("/api/search/active")).provider, "bing");
  await page
    .getByRole("button", {
      name: `Set ${original.name} as default`,
      exact: true,
    })
    .click();
  await page.waitForFunction(async () => {
    const token = localStorage.getItem("amiro.session-token");
    const r = await fetch("/api/search/active", {
      headers: { Authorization: `Bearer ${token}` },
    });
    return (await r.json()).provider === "inference-provider-native";
  });
  await context.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.getByTestId("search-provider-card").first().waitFor();
  assert.equal(await page.getByTestId("search-provider-card").count(), 3);
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 2,
    ),
    "Mobile layout does not overflow",
  );
  const dir =
    process.env.JCODE_SCRATCH_DIR ||
    path.join(os.homedir(), ".cache", "amiro-search-check");
  await mkdir(dir, { recursive: true });
  const screenshot = path.join(dir, "amiro-search-mobile.png");
  await page.screenshot({ path: screenshot, fullPage: true });
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      checks: [
        "native default",
        "free providers configured",
        "Vellum absent",
        "browser selects Bing default",
        "browser restores native default",
        "mobile cards/no overflow",
        "no page errors",
      ],
      screenshot,
    }),
  );
} finally {
  await api(
    `/api/search/providers/${encodeURIComponent(original.id)}/activate`,
    { method: "POST" },
  );
  await browser.close();
}
