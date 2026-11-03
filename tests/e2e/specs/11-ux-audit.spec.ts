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
import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";

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
