/**
 * Shared bits for the showcase scenes. Each `test` is one video: tag it with
 * `scene(slug)` and export-media.mjs writes docs/assets/showcase/<slug>.mp4
 * and <slug>.gif from its recording.
 */
import * as os from "node:os";
import type { Page } from "@playwright/test";
import { assistantMessages, newChat, selectModel, send, waitForReply } from "../e2e/support/chat";
import { test as base } from "../e2e/support/fixtures";

export { expect } from "../e2e/support/fixtures";
export { assistantMessages, newChat, selectModel, send, waitForReply };

/**
 * Rewrites the recording machine's home folder in every text node and title
 * on the page (the sandbox lives under it, and the TV names real paths), so
 * the videos show `/home/priya/.amiro/…` instead of whoever recorded them.
 */
const MASK_SCRIPT = ({ home }: { home: string }) => {
  const esc = home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const sandbox = new RegExp(`${esc}/\\.cache/amx-e2e-sandbox-[A-Za-z0-9]+/home`, "g");
  const bare = new RegExp(esc, "g");
  const fix = (s: string) => s.replace(sandbox, "/home/priya/.amiro").replace(bare, "/home/priya");
  const walk = (root: Node) => {
    const it = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = it.nextNode(); n; n = it.nextNode()) {
      if (n.nodeValue?.includes(home)) n.nodeValue = fix(n.nodeValue);
    }
    if (root instanceof Element) {
      for (const el of [root, ...root.querySelectorAll("[title]")]) {
        const t = el.getAttribute("title");
        if (t?.includes(home)) el.setAttribute("title", fix(t));
      }
    }
  };
  const start = () => {
    walk(document.body);
    new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === "characterData") walk(r.target);
        for (const n of r.addedNodes) walk(n);
        if (r.type === "attributes") walk(r.target);
      }
    }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["title"] });
  };
  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start);
};

export const test = base.extend({
  context: async ({ context }, use) => {
    await context.addInitScript(MASK_SCRIPT, { home: os.homedir() });
    await use(context);
  },
});

/** Names the video this test produces (docs/assets/showcase/<slug>.*). */
export function scene(slug: string) {
  test.info().annotations.push({ type: "showcase", description: slug });
}

/** Let the viewer read what is on screen. */
export async function hold(page: Page, ms = 2500) {
  await page.waitForTimeout(ms);
}

/** Open a new chat on the configured model (muse-spark, else deepseek). */
export async function freshChat(page: Page) {
  await newChat(page);
  await selectModel(page);
}

/** Ask like a user and wait for the whole answer; scroll so it is in view. */
export async function askAndShow(page: Page, prompt: string, timeoutMs = 300000) {
  const before = await assistantMessages(page).count();
  await send(page, prompt);
  const reply = await waitForReply(page, { before, timeoutMs, stableMs: 5000 });
  await assistantMessages(page).last().scrollIntoViewIfNeeded().catch(() => {});
  return reply;
}

/** Slowly scroll the chat back through the answer so the video shows all of it. */
export async function readThrough(page: Page) {
  const last = assistantMessages(page).last();
  await last.evaluate((el) => el.scrollIntoView({ block: "start", behavior: "smooth" })).catch(() => {});
  await page.waitForTimeout(1500);
  await page.mouse.move(720, 450);
  for (let i = 0; i < 6; i += 1) {
    await page.mouse.wheel(0, 320);
    await page.waitForTimeout(700);
  }
}
