/**
 * Real finger gestures for phone journeys. `mouse.wheel` scrolls things a
 * finger can't (and misses touch-only bugs), so swipes go through Chrome's
 * touch events: the same path a phone's touchscreen takes.
 */
import type { CDPSession, Locator, Page } from "@playwright/test";

const sessions = new WeakMap<Page, CDPSession>();

async function cdp(page: Page) {
  let s = sessions.get(page);
  if (!s) {
    s = await page.context().newCDPSession(page);
    sessions.set(page, s);
  }
  return s;
}

/** Drag a finger from (x, y) up by `dy` px (negative = down), like a swipe. */
export async function swipe(page: Page, x: number, y: number, dy: number) {
  const s = await cdp(page);
  const steps = 12;
  await s.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (let i = 1; i <= steps; i++) {
    await s.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y - (dy * i) / steps }] });
    await page.waitForTimeout(16);
  }
  await s.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  // Let the fling settle so the next reading is final.
  await page.waitForTimeout(400);
}

/** Swipe with the finger starting on the middle of `target`. */
export async function swipeOn(target: Locator, dy: number) {
  const box = await target.boundingBox();
  if (!box) throw new Error("swipe target is not on screen");
  await swipe(target.page(), box.x + box.width / 2, box.y + Math.min(box.height / 2, 120), dy);
}

/** The element's current scroll offset. */
export function scrollTopOf(target: Locator) {
  return target.evaluate((el) => Math.round(el.scrollTop));
}

/** How far right of the viewport any visible element in `root` reaches (0 = fits). */
export function overflowRight(page: Page, root = "main") {
  return page.evaluate((sel) => {
    const W = window.innerWidth;
    let worst = 0;
    for (const el of document.querySelectorAll(`${sel} *`)) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      // Content inside a sideways scroller (tab strips, tables) may run on.
      let p = el.parentElement;
      let scrolls = false;
      while (p && p !== document.body) {
        if (/(auto|scroll)/.test(getComputedStyle(p).overflowX)) { scrolls = true; break; }
        p = p.parentElement;
      }
      if (!scrolls) worst = Math.max(worst, r.right - W);
    }
    return Math.round(worst);
  }, root);
}
