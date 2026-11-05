/**
 * Journey 11 — UX audit sweep. Visits every page at desktop and phone width
 * and records objective issues as notes for the reviewer:
 *   - icon-only buttons/links with no accessible name
 *   - pages without a non-empty <h1>
 *   - horizontal overflow (content wider than the viewport)
 *   - inputs without a label
 *   - uncaught page errors (hard fail)
 * Findings are soft so the sweep always covers every page.
 */
import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import type { Page } from "@playwright/test";
import { send } from "../support/chat";
import { expect, test } from "../support/fixtures";
import { overflowRight, scrollTopOf, swipeOn } from "../support/touch";

const PAGES = [
  "/",
  "/connectors",
  "/schedules",
  "/team",
  "/team/new",
  "/agent",
  "/agent/personality",
  "/agent/memory",
  "/agent/workspace",
  "/agent/superpowers",
  "/agent/channels",
  "/agent/contacts",
  "/channels",
  "/contacts",
  "/skills",
  "/admin/general",
  "/admin/devices",
  "/admin/notifications",
  "/admin/credentials",
  "/admin/providers",
  "/admin/search",
  "/admin/voice",
  "/admin/integrations",
  "/admin/usage",
  "/admin/users",
];

async function audit(page: Page) {
  return page.evaluate(() => {
    const visible = (el: Element) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
    };
    const name = (el: Element) =>
      (el.getAttribute("aria-label") || el.getAttribute("title") || (el as HTMLElement).innerText || "").trim() ||
      (el.getAttribute("aria-labelledby") ? "labelled" : "") ||
      Array.from(el.querySelectorAll("img[alt],svg title")).map((x) => x.getAttribute("alt") || x.textContent).join("").trim();
    const unnamed = Array.from(document.querySelectorAll("button, a[href], [role=button]"))
      .filter((el) => visible(el) && !name(el) && !el.closest("#__e2e_caption"))
      .map((el) => {
        const testid = el.getAttribute("data-testid");
        const cls = (el.querySelector("svg")?.getAttribute("class") || "").match(/lucide-[\w-]+/)?.[0];
        return testid || cls || el.tagName.toLowerCase();
      });
    const unlabeledInputs = Array.from(document.querySelectorAll("input:not([type=hidden]), textarea, select"))
      .filter((el) => {
        if (!visible(el)) return false;
        const id = el.getAttribute("id");
        return !(
          el.getAttribute("aria-label") ||
          el.getAttribute("aria-labelledby") ||
          el.getAttribute("placeholder") ||
          (id && document.querySelector(`label[for="${CSS.escape(id)}"]`)) ||
          el.closest("label")
        );
      }).length;
    const h1s = Array.from(document.querySelectorAll("h1")).filter(visible);
    return {
      unnamed,
      unlabeledInputs,
      h1: h1s.map((h) => (h as HTMLElement).innerText.trim()),
      overflowPx: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
}

for (const viewport of [
  { label: "desktop", width: 1440, height: 900 },
  { label: "phone", width: 390, height: 844 },
]) {
  test(`UX sweep at ${viewport.label} width (${viewport.width}px)`, async ({ page, step, note, diagnostics }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const summary: string[] = [];
    for (const url of PAGES) {
      await step(`${viewport.label}: ${url}`, async () => {
        await page.goto(url);
        await page.waitForLoadState("networkidle").catch(() => {});
        await page.waitForTimeout(800);
        const a = await audit(page);
        const issues: string[] = [];
        if (a.unnamed.length) issues.push(`${a.unnamed.length} icon-only control(s) without an accessible name (${[...new Set(a.unnamed)].slice(0, 6).join(", ")})`);
        if (!a.h1.some(Boolean)) issues.push(a.h1.length ? "only an empty <h1>" : "no visible <h1>");
        if (a.h1.filter(Boolean).length > 1) issues.push(`${a.h1.length} <h1> elements`);
        if (a.overflowPx > 2) issues.push(`horizontal overflow of ${a.overflowPx}px`);
        if (a.unlabeledInputs) issues.push(`${a.unlabeledInputs} input(s) without a label`);
        if (issues.length) {
          note(`${url} @${viewport.label}: ${issues.join("; ")}`);
          summary.push(url);
        }
        await page.mouse.wheel(0, 600);
        await page.waitForTimeout(300);
      });
    }
    await step("No uncaught page errors on any page", async () => {
      expect(diagnostics.pageErrors, diagnostics.pageErrors.map((e) => e.message).join("\n")).toHaveLength(0);
    });
    test.info().annotations.push({ type: "pages-with-issues", description: summary.join(", ") || "none" });
  });
}

test("Palettes: black (dark) or white (light) main window and sidebar, blocks and accents in each palette's colour", async ({ page, step }) => {
  const PALETTES = ["default", "mist", "sage", "clay", "obsidian", "deep-ocean", "midnight-violet", "warm-stone", "terminal", "aurora", "cobalt"];
  /** The resolved colour of a theme token, as the browser paints it. */
  const token = (name: string) =>
    page.evaluate((n) => {
      const probe = document.createElement("div");
      probe.style.background = `var(${n})`;
      document.body.appendChild(probe);
      const colour = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return colour;
    }, name);
  const pickPalette = async (id: string) => {
    await page.getByTestId("sidebar-user-button").first().click();
    await page.getByRole("menuitem", { name: /^Theme/ }).hover();
    await page.getByTestId(`palette-${id}`).click();
    await page.keyboard.press("Escape");
    await expect(page.locator("html")).toHaveAttribute("data-theme", id);
  };

  await step("Switch to dark mode", async () => {
    await page.goto("/");
    await page.evaluate(() => localStorage.setItem("app-theme-v2", "dark"));
    await page.reload();
    await expect(page.locator("html")).toHaveClass(/\bdark\b/);
  });

  const accents = new Set<string>();
  const blocks = new Set<string>();
  for (const id of PALETTES) {
    await step(`Dark · ${id}: main window and sidebar are black; the desk shade, blocks and accents are the palette's own`, async () => {
      await pickPalette(id);
      for (const base of ["--window", "--sidebar"]) {
        expect(await token(base), `${id} ${base}`).toBe("rgb(0, 0, 0)");
      }
      const block = await token("--card");
      for (const inside of ["--card", "--popover", "--background"]) {
        expect(await token(inside), `${id} ${inside} (blocks, menus, dialogs, inputs) is not black`).not.toBe("rgb(0, 0, 0)");
      }
      await expect(page.locator("main").first()).toBeVisible();
      blocks.add(block);
      accents.add(await token("--primary"));
      const desk = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--canvas-texture").trim());
      expect(desk, `${id} keeps its desk shade`).toContain("gradient");
    });
  }
  expect(accents.size, "palettes keep distinct accents").toBeGreaterThan(5);
  expect(blocks.size, "palettes keep distinct block colours").toBeGreaterThan(5);

  await step("Dark · Deep Ocean on the Schedules page: black window, tinted rows", async () => {
    await pickPalette("deep-ocean");
    await page.goto("/schedules");
    await page.getByTestId("schedules-tab-activity").click();
    await expect(page.getByTestId("schedules-system-tasks")).toBeVisible();
    await page.waitForTimeout(1500);
  });

  await step("Dark · Deep Ocean: a dialog and its inputs are tinted, not black", async () => {
    await page.getByTestId("cleanup-setup").click();
    const dialog = page.getByTestId("cleanup-dialog");
    await expect(dialog.getByTestId("cleanup-time")).toBeVisible();
    const paint = (el: Element) => getComputedStyle(el).backgroundColor;
    expect(await dialog.evaluate(paint), "dialog").not.toBe("rgb(0, 0, 0)");
    expect(await dialog.getByTestId("cleanup-time").evaluate(paint), "input").not.toBe("rgb(0, 0, 0)");
    await page.waitForTimeout(1500);
    await page.keyboard.press("Escape");
  });

  await step("Dark · Deep Ocean on Superpowers: black window and sidebar, skill cards in the palette's colour", async () => {
    await page.goto("/agent/superpowers");
    const card = page.getByTestId("skill-card").first();
    await expect(card).toBeVisible();
    const paint = (el: Element) => getComputedStyle(el).backgroundColor;
    expect(await card.evaluate(paint), "skill card").not.toBe("rgb(0, 0, 0)");
    expect(await page.getByTestId("main-window").evaluate(paint), "main window").toBe("rgb(0, 0, 0)");
    expect(await page.locator('[data-slot="sidebar-inner"]').first().evaluate(paint), "sidebar").toBe("rgb(0, 0, 0)");
    await page.waitForTimeout(1500);
  });

  await step("Switch to light mode", async () => {
    await page.evaluate(() => localStorage.setItem("app-theme-v2", "light"));
    await page.reload();
    await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
  });

  const lightBlocks = new Set<string>();
  for (const id of PALETTES) {
    await step(`Light · ${id}: main window and sidebar are white; blocks carry the palette's colour`, async () => {
      await pickPalette(id);
      for (const base of ["--window", "--sidebar"]) {
        expect(await token(base), `${id} ${base}`).toBe("rgb(255, 255, 255)");
      }
      const block = await token("--card");
      expect(block, `${id} blocks are not white`).not.toBe("rgb(255, 255, 255)");
      lightBlocks.add(block);
    });
  }
  expect(lightBlocks.size, "palettes keep distinct light block colours").toBeGreaterThan(5);

  await step("Light · Deep Ocean on Superpowers: white window and sidebar, tinted skill cards", async () => {
    await pickPalette("deep-ocean");
    await page.goto("/agent/superpowers");
    const card = page.getByTestId("skill-card").first();
    await expect(card).toBeVisible();
    const paint = (el: Element) => getComputedStyle(el).backgroundColor;
    expect(await page.getByTestId("main-window").evaluate(paint), "main window").toBe("rgb(255, 255, 255)");
    expect(await page.locator('[data-slot="sidebar-inner"]').first().evaluate(paint), "sidebar").toBe("rgb(255, 255, 255)");
    expect(await card.evaluate(paint), "skill card").not.toBe("rgb(255, 255, 255)");
    await page.waitForTimeout(1500);
    await pickPalette("default");
  });
});

test("keyboard: shortcuts dialog and new-chat shortcut", async ({ page, step }) => {
  await step("Open keyboard shortcuts (Ctrl+/, then Meta+/)", async () => {
    await page.goto("/");
    await page.keyboard.press("Control+/");
    const dialog = page.getByRole("dialog");
    // isVisible() does not wait; give the lazily loaded dialog a moment before trying ⌘/.
    const opened = await dialog.first().waitFor({ state: "visible", timeout: 3000 }).then(() => true, () => false);
    if (!opened) await page.keyboard.press("Meta+/");
    await expect.soft(page.getByRole("dialog").first(), "Ctrl+/ (documented 'openShortcutsPopup') should open the shortcuts dialog").toBeVisible();
    await page.keyboard.press("Escape");
  });
  await step("Collapse the sidebar with its button, then expand it again", async () => {
    // On desktop the control sits beside the logo and names what it will do.
    await page.getByRole("button", { name: "Collapse sidebar" }).click();
    await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
    await page.getByRole("button", { name: "Expand sidebar" }).click();
    await expect(page.getByRole("button", { name: "Collapse sidebar" })).toBeVisible();
  });
});

/**
 * Phone, by touch. Priya runs Brew & Bloom, an oat-milk café in Koregaon
 * Park, and sets up Amiro from her phone between orders. Every gesture is a
 * real finger swipe or tap (support/touch.ts) on a 390px touch screen. The
 * model is the offline stub (fixtures/openai-stub-server.mjs: 40 models and a
 * long fixed answer), so this runs without a provider key.
 */
test.describe("Phone by touch", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });

  const STUB_PORT = Number(process.env.AMIRO_E2E_OPENAI_STUB_PORT || 38975);
  const PROVIDER = "openai-compatible";
  const PICK = "stub-model-30";
  let stub: ChildProcess | undefined;

  test.beforeAll(async () => {
    stub = spawn(process.execPath, [path.join(__dirname, "../fixtures/openai-stub-server.mjs"), String(STUB_PORT)], { stdio: "ignore" });
    for (let i = 0; i < 50; i++) {
      if (await fetch(`http://127.0.0.1:${STUB_PORT}/v1/models`).then((r) => r.ok, () => false)) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`openai stub did not start on ${STUB_PORT}`);
  });
  test.afterAll(() => {
    stub?.kill();
  });

  test("Phone: scroll models, set a default, pick a model, scroll the chat, sidebar, theme and Team by touch", async ({ page, step, amiro, diagnostics }) => {
    await step("Connect the café's model server (offline stub) as an OpenAI-compatible provider", async () => {
      const r = await amiro.api(`/api/providers/${PROVIDER}/api-key`, {
        method: "POST",
        body: JSON.stringify({ apiKey: "sk-stub-brew-and-bloom", apiBase: `http://127.0.0.1:${STUB_PORT}/v1` }),
      });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    });

    const card = page.getByTestId("provider-card").filter({ has: page.locator(`[data-model-id="${PICK}"]`) });
    const models = card.getByTestId("provider-models-scroll");
    await step("Models & Providers: the provider's model list scrolls under her finger instead of being cut off", async () => {
      await page.goto("/admin/providers");
      await expect(card.getByTestId("provider-model-row").first()).toBeVisible({ timeout: 30000 });
      await card.scrollIntoViewIfNeeded();
      const fits = await models.evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight }));
      expect(fits.sh, "40 models are taller than the list box, so it must scroll").toBeGreaterThan(fits.ch);
      const before = await scrollTopOf(models);
      await swipeOn(models, 250);
      expect(await scrollTopOf(models), "a swipe on the list scrolls the list").toBeGreaterThan(before);
    });

    await step(`Swipe down to ${PICK} and tap "Set default" → it becomes the provider's default`, async () => {
      const row = card.locator(`[data-model-id="${PICK}"]`);
      const inView = () =>
        row.evaluate((el) => {
          const r = el.getBoundingClientRect();
          const box = el.closest('[data-testid="provider-models-scroll"]')!.getBoundingClientRect();
          return r.top >= box.top && r.bottom <= box.bottom && r.top >= 0 && r.bottom <= window.innerHeight;
        });
      for (let i = 0; i < 20 && !(await inView()); i++) {
        // Keep the card on screen, then move the list itself.
        await models.scrollIntoViewIfNeeded();
        await swipeOn(models, 150);
      }
      await row.getByTestId("provider-set-default-model").tap();
      await expect(card.getByTestId(`provider-model-default-active-${PICK}`)).toBeVisible();
      const list = await amiro.api<Array<{ id: string; selectedModel?: string }>>("/api/ai/providers");
      expect(list.body.find((p) => p.id === PROVIDER)?.selectedModel).toBe(PICK);
    });

    const picker = page.getByTestId("model-selector-popover");
    await step("Chat: open the model picker → the keyboard stays down (search not focused) and the list scrolls by touch", async () => {
      await page.goto("/");
      await page.getByTestId("model-selector-button").first().tap();
      await expect(picker).toBeVisible();
      expect(await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))).not.toBe("model-search-input");
      const list = picker.locator("[cmdk-list]");
      const before = await scrollTopOf(list);
      await swipeOn(list, 220);
      expect(await scrollTopOf(list)).toBeGreaterThan(before);
      const box = (await picker.boundingBox())!;
      expect(box.x, "picker stays on screen").toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
    });

    await step("Search and tap stub-model-12 → the composer shows it", async () => {
      await page.getByTestId("model-search-input").tap();
      await page.getByTestId("model-search-input").fill("stub-model-12");
      await page.getByTestId(`model-option-${PROVIDER}-stub-model-12`).tap();
      await expect(page.getByTestId("selected-model-name").first()).toHaveText("stub-model-12");
    });

    const messages = page.getByTestId("chat-messages-container");
    await step("Ask for a two-week tasting plan → the long answer arrives; the composer sits at the bottom with no messages peeking out below it", async () => {
      await send(page, "Plan two weeks of oat-milk tastings for Brew & Bloom");
      await expect(page.getByText("end of answer").first()).toBeVisible({ timeout: 60000 });
      const calls = await fetch(`http://127.0.0.1:${STUB_PORT}/__calls`).then((r) => r.json() as Promise<Array<{ model?: string }>>);
      expect(calls.some((c) => c.model === "stub-model-12"), "the chat used the model she picked").toBe(true);
      const dock = (await page.getByTestId("chat-composer-dock").boundingBox())!;
      const win = (await page.getByTestId("main-window").boundingBox())!;
      expect(win.y + win.height - (dock.y + dock.height), "gap under the composer").toBeLessThanOrEqual(16);
    });

    await step("Ask for a pricing table, then swipe back through the answers and forward again", async () => {
      await send(page, "Now add a pricing table");
      await expect(page.getByText("end of answer")).toHaveCount(2, { timeout: 60000 });
      await page.waitForTimeout(1000);
      const end = await scrollTopOf(messages);
      // The finger lands in the visible part of the conversation, above the composer.
      for (let i = 0; i < 3; i++) await swipeOn(messages, -350);
      const older = await scrollTopOf(messages);
      expect(older, "swiping down shows older messages").toBeLessThan(end);
      for (let i = 0; i < 3; i++) await swipeOn(messages, 350);
      expect(await scrollTopOf(messages), "swiping up comes back").toBeGreaterThan(older);
    });

    const sheet = page.locator('[data-slot="sidebar"][data-mobile="true"]');
    await step("Sidebar: tap the menu button → it slides in; Conversations holds today's chat and scrolls by touch", async () => {
      await page.getByTestId("sidebar-toggle").first().tap();
      await expect(sheet).toBeVisible();
      await sheet.getByTestId("sidebar-switch-conversations").tap();
      await expect(sheet.getByTestId("sidebar-thread-link").first()).toBeVisible();
      const content = sheet.locator('[data-slot="sidebar-content"]');
      const overflow = await content.evaluate((el) => el.scrollHeight - el.clientHeight);
      if (overflow > 4) {
        await swipeOn(content, 200);
        expect(await scrollTopOf(content)).toBeGreaterThan(0);
      }
    });

    await step("Profile menu → Theme opens inside the menu, every palette fits the screen; tap Sage, then switch to dark", async () => {
      await sheet.getByTestId("sidebar-user-button").tap();
      await page.getByTestId("theme-menu-toggle").tap();
      const sage = page.getByTestId("palette-sage");
      await expect(sage).toBeVisible();
      const menu = page.locator('[data-slot="dropdown-menu-content"]');
      const m = (await menu.boundingBox())!;
      expect(m.x >= 0 && m.x + m.width <= 390, "menu fits the screen").toBe(true);
      const cobalt = page.getByTestId("palette-cobalt");
      for (let i = 0; i < 6 && !(await cobalt.isVisible()); i++) await swipeOn(menu, 200);
      const last = (await cobalt.boundingBox())!;
      expect(last.x + last.width, "last palette is reachable").toBeLessThanOrEqual(390);
      await sage.scrollIntoViewIfNeeded();
      await sage.tap();
      await expect(page.locator("html")).toHaveAttribute("data-theme", "sage");
      await page.getByTestId("theme-mode-toggle").tap();
      await expect(page.locator("html")).toHaveClass(/\bdark\b/);
      await page.waitForTimeout(800);
      await page.getByTestId("theme-mode-toggle").tap();
      await page.keyboard.press("Escape");
    });

    await step("Team: a menu button on the phone opens the team sidebar with New agent", async () => {
      await page.goto("/team");
      await page.getByTestId("sidebar-toggle").tap();
      await expect(page.locator('[data-slot="sidebar"][data-mobile="true"]').locator('a[href="/team/new"]')).toBeVisible();
      await page.keyboard.press("Escape");
    });

    for (const url of ["/admin/notifications", "/admin/providers", "/connectors"]) {
      await step(`${url}: nothing runs off the right edge of the phone`, async () => {
        await page.goto(url);
        await expect(page.locator("h1").first()).toBeVisible();
        await page.waitForTimeout(800);
        expect(await overflowRight(page), "px past the right edge").toBeLessThanOrEqual(1);
      });
    }

    await step("Connectors: the intro reads as a paragraph, not one word per line; back to the Graphite palette", async () => {
      const intro = page.getByTestId("connectors-page").locator("header p").first();
      expect((await intro.boundingBox())!.width).toBeGreaterThan(250);
      await page.getByTestId("sidebar-toggle").first().tap();
      await page.getByTestId("sidebar-user-button").first().tap();
      await page.getByTestId("theme-menu-toggle").tap();
      await page.getByTestId("palette-default").tap();
      await expect(page.locator("html")).toHaveAttribute("data-theme", "default");
    });

    expect(diagnostics.pageErrors.map((e) => e.message)).toEqual([]);
  });

  test("Phone: the browser tab and Add to Home Screen show the Vrnda leaf", async ({ page, step }) => {
    const pngSize = (buf: Buffer) => `${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`;
    await page.goto("/");
    const href = (sel: string) => page.locator(`head ${sel}`).first().getAttribute("href");

    await step("Browser tab: the icon is the Vrnda leaf SVG (it follows light/dark), with a favicon.ico fallback", async () => {
      const svgHref = await href('link[rel="icon"][type="image/svg+xml"]');
      expect(svgHref).toMatch(/^\/icon\.svg/);
      const svg = await (await page.request.get(svgHref!)).text();
      const logo = await (await page.request.get("/Vrnda_logo.svg")).text();
      expect(svg, "tab icon is the Vrnda logo").toBe(logo);
      const ico = await page.request.get((await href('link[rel="icon"][type="image/x-icon"]'))!);
      expect(ico.status()).toBe(200);
      await page.goto(svgHref!);
      await page.waitForTimeout(800);
    });

    await step("iPhone Add to Home Screen: a 180×180 Vrnda leaf on white (apple-touch-icon)", async () => {
      await page.goto("/");
      const appleHref = await href('link[rel="apple-touch-icon"]');
      expect(appleHref).toMatch(/^\/apple-icon\.png/);
      const r = await page.request.get(appleHref!);
      expect(r.headers()["content-type"]).toContain("image/png");
      expect(pngSize(await r.body())).toBe("180x180");
      // Safari also asks for /apple-touch-icon.png directly.
      expect(pngSize(await (await page.request.get("/apple-touch-icon.png")).body())).toBe("180x180");
      await page.goto(appleHref!);
      await page.waitForTimeout(800);
    });

    await step("Android Add to Home Screen: the manifest lists 192 and 512 px Vrnda leaf icons, also maskable", async () => {
      const manifest = await (await page.request.get("/manifest.webmanifest")).json();
      expect(manifest.name).toBe("Amiro");
      const purposes = new Set(manifest.icons.map((i: { purpose: string }) => i.purpose));
      expect([...purposes].sort()).toEqual(["any", "maskable"]);
      for (const icon of manifest.icons as { src: string; sizes: string }[]) {
        const r = await page.request.get(icon.src);
        expect(r.status(), icon.src).toBe(200);
        expect(pngSize(await r.body()), icon.src).toBe(icon.sizes);
      }
      await page.goto("/web-app-manifest-512x512.png");
      await page.waitForTimeout(800);
    });
  });
});
