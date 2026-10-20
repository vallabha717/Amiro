/**
 * The one `test` every E2E spec imports.
 *
 * What it adds over plain Playwright:
 *   - baseURL / auth come from the instance global-setup booted
 *   - `step(title, fn)`: a test.step that also shows a caption bar in the
 *     recorded video and logs the video timestamp, so a reviewer (human or
 *     agent) can map every second of video to what the test was doing
 *   - console errors, page errors and failed API calls are collected per test
 *     and attached as `diagnostics.json` for the review report
 *   - `amiro.api()` for setup/assertions that are not the thing under test
 */
import { test as base, expect, type Page, type TestInfo } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { type E2EConfig, TESTS_DIR, loadConfig, readInstance } from "./config";

export const AUTH_FILE = path.join(TESTS_DIR, ".e2e-state", "auth.json");

export interface StepRecord {
  title: string;
  atMs: number;
  durationMs?: number;
  status?: "passed" | "failed";
}

/** "bug" = product defect found by a prerequisite journey that must not fail (it would skip every dependent journey). */
export type NoteKind = "bug" | "ux" | "info";

interface Diagnostics {
  consoleErrors: { atMs: number; text: string; url: string }[];
  pageErrors: { atMs: number; message: string }[];
  failedRequests: { atMs: number; status: number; method: string; url: string }[];
  notes: { atMs: number; kind: NoteKind; text: string }[];
}

export interface Amiro {
  cfg: E2EConfig;
  baseUrl: string;
  mcpBase: string;
  /** JSON fetch against the backend as the owner (token from the UI session). */
  api: <T = unknown>(p: string, init?: RequestInit) => Promise<{ status: number; body: T }>;
  token: () => Promise<string>;
}

const CAPTION_SCRIPT = () => {
  const KEY = "__e2e_caption";
  const render = () => {
    const text = sessionStorage.getItem(KEY) || "";
    let el = document.getElementById("__e2e_caption");
    if (!text) {
      el?.remove();
      return;
    }
    if (!el) {
      el = document.createElement("div");
      el.id = "__e2e_caption";
      el.setAttribute("aria-hidden", "true");
      el.style.cssText =
        "position:fixed;left:50%;bottom:14px;transform:translateX(-50%);z-index:2147483647;" +
        "max-width:80vw;padding:8px 16px;border-radius:10px;background:rgba(15,23,42,.88);color:#fff;" +
        "font:600 14px/1.35 system-ui,sans-serif;pointer-events:none;box-shadow:0 6px 24px rgba(0,0,0,.35);" +
        "border:1px solid rgba(255,255,255,.15);white-space:pre-wrap;text-align:center";
      (document.body || document.documentElement).appendChild(el);
    }
    if (el.textContent !== text) el.textContent = text;
  };
  const tick = () => {
    try {
      render();
    } catch {}
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", tick);
  else tick();
  setInterval(tick, 250);
};

type Fixtures = {
  amiro: Amiro;
  step: <T>(title: string, fn: () => Promise<T>) => Promise<T>;
  note: (text: string, kind?: NoteKind) => void;
  diagnostics: Diagnostics;
  videoClock: { t0: number; now: () => number };
};

export const test = base.extend<Fixtures>({
  baseURL: async ({}, use) => {
    await use(readInstance().baseUrl);
  },

  storageState: async ({}, use) => {
    await use(fs.existsSync(AUTH_FILE) ? AUTH_FILE : undefined);
  },

  videoClock: async ({}, use) => {
    const t0 = Date.now();
    await use({ t0, now: () => Date.now() - t0 });
  },

  diagnostics: async ({}, use, testInfo) => {
    const d: Diagnostics = { consoleErrors: [], pageErrors: [], failedRequests: [], notes: [] };
    await use(d);
    await testInfo.attach("diagnostics.json", { body: JSON.stringify(d, null, 2), contentType: "application/json" });
  },

  page: async ({ page, videoClock, diagnostics }, use) => {
    const cfg = loadConfig();
    if (cfg.recording.captions) await page.context().addInitScript(CAPTION_SCRIPT);
    page.on("console", (m) => {
      if (m.type() === "error")
        diagnostics.consoleErrors.push({ atMs: videoClock.now(), text: m.text().slice(0, 500), url: page.url() });
    });
    page.on("pageerror", (e) => diagnostics.pageErrors.push({ atMs: videoClock.now(), message: e.message.slice(0, 500) }));
    page.on("response", (r) => {
      const u = r.url();
      if (r.status() >= 400 && u.includes("/api/"))
        diagnostics.failedRequests.push({ atMs: videoClock.now(), status: r.status(), method: r.request().method(), url: u });
    });
    await use(page);
  },

  note: async ({ diagnostics, videoClock }, use) => {
    await use((text, kind = "ux") => diagnostics.notes.push({ atMs: videoClock.now(), kind, text }));
  },

  step: async ({ page, videoClock }, use, testInfo) => {
    const steps: StepRecord[] = [];
    await use(async (title, fn) => {
      const rec: StepRecord = { title, atMs: videoClock.now() };
      steps.push(rec);
      await caption(page, title);
      try {
        const out = await base.step(title, fn);
        rec.status = "passed";
        return out;
      } catch (e) {
        rec.status = "failed";
        throw e;
      } finally {
        rec.durationMs = videoClock.now() - rec.atMs;
      }
    });
    await testInfo.attach("steps.json", { body: JSON.stringify(steps, null, 2), contentType: "application/json" });
  },

  amiro: async ({ page, baseURL }, use) => {
    const cfg = loadConfig();
    const baseUrl = baseURL!;
    const token = async () => {
      const fromPage = await page.evaluate(() => localStorage.getItem("amiro.session-token")).catch(() => null);
      if (fromPage) return fromPage;
      const r = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: cfg.owner.email, password: cfg.owner.password }),
      });
      const j = (await r.json()) as { token?: string };
      return j.token ?? "";
    };
    const api: Amiro["api"] = async (p, init = {}) => {
      const t = await token();
      const r = await fetch(`${baseUrl}${p}`, {
        ...init,
        headers: { "content-type": "application/json", authorization: `Bearer ${t}`, ...(init.headers || {}) },
      });
      const text = await r.text();
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {}
      return { status: r.status, body: body as never };
    };
    await use({ cfg, baseUrl, mcpBase: `http://127.0.0.1:${cfg.mcp.fixturePort}`, api, token });
  },
});

export { expect };

/** Show a caption bar in the video. Survives navigations (sessionStorage + init script). */
export async function caption(page: Page, text: string) {
  await page
    .evaluate((t) => {
      sessionStorage.setItem("__e2e_caption", t);
      const el = document.getElementById("__e2e_caption");
      if (el) el.textContent = t;
    }, text)
    .catch(() => {});
}

/** Skip (not fail) when the user's config does not provide something a journey needs. */
export function need(value: unknown, what: string) {
  base.skip(!value, `not configured: ${what} (set it in tests/e2e.config.json)`);
}

/** Make the session reusable by later suites (written after onboarding/sign-in). */
export async function saveAuth(page: Page) {
  fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
  await page.context().storageState({ path: AUTH_FILE });
}

/** Sign in through the real sign-in page when no saved session exists (e.g. running one suite alone). */
export async function ensureSignedIn(page: Page, testInfo?: TestInfo) {
  const cfg = loadConfig();
  await page.goto("/");
  await page.waitForLoadState("domcontentloaded");
  await page.waitForURL(/\/(sign-in|onboarding|setup)?(\?|$)|\/\?thread=|\/$/, { timeout: 30000 });
  if (/sign-in/.test(page.url())) {
    await page.getByLabel(/email|username/i).first().fill(cfg.owner.email);
    await page.getByLabel(/password/i).first().fill(cfg.owner.password);
    await page.getByRole("button", { name: /sign in|log in|continue/i }).first().click();
    await page.waitForURL((u) => !u.pathname.startsWith("/sign-in"), { timeout: 30000 });
    await saveAuth(page);
  }
  void testInfo;
}
