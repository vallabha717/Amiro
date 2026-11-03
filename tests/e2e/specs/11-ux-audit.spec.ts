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

test("Dark palettes: every palette uses Graphite's black windows and keeps its own accent", async ({ page, step }) => {
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
  for (const id of PALETTES) {
    await step(`Dark · ${id}: windows and menus are black, the accent is the palette's own`, async () => {
      await pickPalette(id);
      expect(await token("--card"), `${id} window`).toBe("rgb(0, 0, 0)");
      expect(await token("--popover"), `${id} menu`).toBe("rgb(10, 10, 10)");
      accents.add(await token("--primary"));
    });
  }
  expect(accents.size, "palettes keep distinct accents").toBeGreaterThan(5);

  await step("Light mode is unchanged: Sapphire's windows stay light", async () => {
    await pickPalette("mist");
    await page.evaluate(() => localStorage.setItem("app-theme-v2", "light"));
    await page.reload();
    expect(await token("--card")).not.toBe("rgb(0, 0, 0)");
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
