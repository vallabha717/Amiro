/**
 * Journey 15 — devices: connecting phones and other apps with the device code
 * flow GitHub and GitLab use. The device enters this Amiro's address once,
 * shows a short code, and the owner approves it, in Settings → Devices on the
 * computer or at /device from any signed-in browser. Removing a device signs
 * it out at once.
 *
 * Test 1 is recorded from the phone (this browser at phone size on the
 * phone-access listener, `AMIRO_REMOTE_PORT` from global-setup, so its storage
 * is separate); the computer approves in a second tab. Test 2 is recorded from
 * the approver at /device; a second tab plays the desktop app (Tauri globals
 * simulated) connecting to "another Amiro", which is this instance's phone
 * listener.
 */
import type { Browser, Page, TestInfo } from "@playwright/test";
import { loadConfig, readInstance } from "../support/config";
import { expect, test } from "../support/fixtures";

const cfg = loadConfig();
const remotePort = cfg.target.port + 2;
const remote = `http://127.0.0.1:${remotePort}`;
const external = () => readInstance().mode === "external";
const phone = { width: 390, height: 844 };

/**
 * A second, signed-in tab in its own browser context. Its own context keeps
 * it out of the test's recording, which must stay the main tab's video.
 */
async function otherTab(
  browser: Browser,
  baseURL: string | undefined,
  storageState: unknown,
): Promise<Page> {
  const context = await browser.newContext({
    baseURL,
    storageState: storageState as string | undefined,
    viewport: cfg.recording.viewport,
  });
  return context.newPage();
}

async function snap(tab: Page, testInfo: TestInfo, name: string) {
  await testInfo.attach(name, { body: await tab.screenshot(), contentType: "image/png" });
}

/** The computer's Settings → Devices: answer the request showing `code`. */
async function answerOnComputer(computer: Page, code: string, approve: boolean) {
  await computer.goto("/admin/devices");
  const request = computer.getByTestId("devices-request").filter({ hasText: code });
  await expect(request).toBeVisible({ timeout: 15000 });
  await request.getByTestId(approve ? "devices-request-approve" : "devices-request-deny").click();
  await expect(request).toBeHidden({ timeout: 15000 });
}

async function askForCode(tab: Page): Promise<string> {
  await tab.getByTestId("pair-submit").click();
  const shown = tab.getByTestId("pair-user-code");
  await expect(shown).toBeVisible({ timeout: 15000 });
  const code = (await shown.innerText()).trim();
  expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  return code;
}

test.describe("devices", () => {
  test("devices: a phone on Wi-Fi asks with a code → denied, then approved in Settings → its own session → removing it signs it out", async ({
    page,
    step,
    amiro,
    browser,
    baseURL,
    storageState,
  }, testInfo) => {
    test.skip(external(), "needs the isolated instance's phone-access port");
    page.on("dialog", (dialog) => dialog.accept());
    const computer = await otherTab(browser, baseURL, storageState);
    computer.on("dialog", (dialog) => dialog.accept());

    await step("Settings → Devices: phone access is off, so there is no address to connect to yet", async () => {
      await page.goto("/admin/devices");
      await expect(page.getByRole("heading", { level: 1, name: "Devices" })).toBeVisible();
      await expect(page.getByTestId("devices-requests")).toContainText("No device is waiting");
      await expect(page.getByTestId("devices-connect")).toContainText("Turn on phone access first");
    });

    await step("Turn on Allow phones on my network → listening, with the Wi-Fi address and its QR code", async () => {
      await page.getByTestId("devices-phone-access-port").fill(String(remotePort));
      await page.getByTestId("devices-phone-access-switch").click();
      await expect(page.getByTestId("devices-phone-access-status")).toContainText(
        `Listening on port ${remotePort}`,
        { timeout: 15000 },
      );
      await expect(page.getByTestId("devices-connect-qr")).toBeVisible({ timeout: 15000 });
      await page.waitForTimeout(800);
    });

    await step("The Wi-Fi listener refuses a password sign-in and ordinary sessions", async () => {
      const login = await fetch(`${remote}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: cfg.owner.email, password: cfg.owner.password }),
      });
      expect(login.status).toBe(401);
      const owner = await fetch(`${remote}/api/auth/session`, {
        headers: { Authorization: `Bearer ${await amiro.token()}` },
      });
      expect(owner.status, "an ordinary session is not a paired device").toBe(401);
    });

    let code = "";
    await step("On the phone: open the address (the QR code) → it is filled in → Get a code", async () => {
      await page.setViewportSize(phone);
      await page.goto(`${remote}/pair`);
      await expect(page.getByTestId("pair-server-input")).toHaveValue(remote);
      await page.getByTestId("pair-name-input").fill("Test phone");
      code = await askForCode(page);
      await expect(page.getByTestId("pair-waiting")).toContainText("Settings → Devices");
    });

    await step("On the computer: Waiting for approval shows the phone's code → Deny → the phone says it was denied", async () => {
      await answerOnComputer(computer, code, false);
      await expect(page.getByTestId("pair-denied")).toBeVisible({ timeout: 20000 });
    });

    await step("The phone asks again → a new code → approved on the computer → the phone connects by itself", async () => {
      code = await askForCode(page);
      await answerOnComputer(computer, code, true);
      await snap(computer, testInfo, "computer-approved.png");
      await page.waitForURL((url) => url.port === String(remotePort) && url.pathname !== "/pair", {
        timeout: 20000,
      });
    });

    await step("The phone is signed in as the owner with its own session, no password", async () => {
      await expect(page).not.toHaveURL(/sign-in/);
      const token = await page.evaluate(() => localStorage.getItem("amiro.session-token"));
      expect(token).toBeTruthy();
      const me = await fetch(`${remote}/api/auth/session`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(me.status).toBe(200);
      await page.waitForTimeout(1500);
    });

    await step("Back on the computer: Paired devices lists the phone with its address → Remove it", async () => {
      await page.setViewportSize(cfg.recording.viewport);
      await page.goto("/admin/devices");
      const item = page.getByTestId("devices-list-item").filter({ hasText: "Test phone" });
      await expect(item).toBeVisible({ timeout: 15000 });
      await item.getByTestId("devices-list-revoke").click();
      await expect(item).toBeHidden({ timeout: 15000 });
    });

    await step("The phone is signed out at once and offered to connect again", async () => {
      await page.setViewportSize(phone);
      await page.goto(`${remote}/`);
      await page.waitForURL(/sign-in/, { timeout: 20000 });
      await expect(page.getByTestId("signin-pair-link")).toBeVisible();
    });

    await step("Turn phone access off → the listener closes", async () => {
      await page.setViewportSize(cfg.recording.viewport);
      await page.goto("/admin/devices");
      await page.getByTestId("devices-phone-access-switch").click();
      await expect(page.getByTestId("devices-phone-access-status")).toContainText("Off", {
        timeout: 15000,
      });
      await expect(fetch(`${remote}/api/auth/status`)).rejects.toThrow();
    });
    await computer.context().close();
  });

  test("devices: approve at /device from any browser — sign in, check the code, approve → the desktop app connects to that Amiro → switch back", async ({
    page,
    step,
    amiro,
    browser,
    baseURL,
    storageState,
  }, testInfo) => {
    test.skip(external(), "needs the isolated instance's phone-access port");
    const on = await amiro.api("/api/devices/remote-access", {
      method: "PUT",
      body: JSON.stringify({ enabled: true, port: remotePort }),
    });
    expect(on.status).toBe(200);

    // The desktop app: Tauri injects only the backend port, never the served
    // page's __BACKEND_ORIGIN__ (config.ts hasLocalBackend).
    const desktop = await otherTab(browser, baseURL, storageState);
    await desktop.addInitScript((port) => {
      Object.defineProperty(window, "__BACKEND_ORIGIN__", { get: () => undefined, set: () => {} });
      Object.defineProperty(window, "__BACKEND_PORT__", { get: () => port, set: () => {} });
    }, cfg.target.port);

    let code = "";
    await step("The desktop app (other tab): Connect to another Amiro → its address → Get a code", async () => {
      await desktop.goto("/admin/devices");
      await expect(desktop.getByTestId("devices-connection-current")).toHaveText("This computer");
      await desktop.getByTestId("devices-connect-other").click();
      await desktop.waitForURL(/\/pair/);
      await expect(desktop.getByTestId("pair-name-input")).toHaveValue("Desktop app");
      await desktop.getByTestId("pair-server-input").fill(remote);
      code = await askForCode(desktop);
      await snap(desktop, testInfo, "desktop-waiting.png");
    });

    await step("In a signed-out browser: open <server>/device?code=… → asked to sign in first", async () => {
      await page.goto("/sign-in");
      await page.evaluate(() => localStorage.removeItem("amiro.session-token"));
      await page.goto(`/device?code=${code}`);
      await page.waitForURL(/sign-in\?next=/, { timeout: 15000 });
    });

    await step("Sign in → straight back to /device with the code filled in", async () => {
      await page.getByTestId("signin-email-input").fill(cfg.owner.email);
      await page.getByTestId("signin-password-input").fill(cfg.owner.password);
      await page.getByTestId("signin-submit-button").click();
      await page.waitForURL(/\/device\?code=/, { timeout: 20000 });
      await expect(page.getByTestId("device-approve-code")).toHaveValue(code);
    });

    await step("A wrong code finds nothing", async () => {
      await page.getByTestId("device-approve-code").fill("ZZZZ-ZZZZ");
      await page.getByTestId("device-approve-find").click();
      await expect(page.getByTestId("device-approve-error")).toContainText("no device is waiting");
    });

    await step("The right code → shows what is asking: Desktop app, where from, when, and the code", async () => {
      await page.getByTestId("device-approve-code").fill(code);
      await page.getByTestId("device-approve-find").click();
      const request = page.getByTestId("device-approve-request");
      await expect(request).toBeVisible();
      await expect(page.getByTestId("device-approve-name")).toHaveText("Desktop app");
      await expect(request).toContainText(code);
      await expect(request).toContainText("127.0.0.1");
      await expect(request).toContainText("If someone sent you this code");
      await page.waitForTimeout(1200);
    });

    await step("Approve → Desktop app is connected", async () => {
      await page.getByTestId("device-approve-yes").click();
      await expect(page.getByTestId("device-approve-done")).toContainText("Desktop app is connected");
      await page.waitForTimeout(1200);
    });

    await step("The desktop app connected by itself and now uses the other Amiro (shown with its address)", async () => {
      await desktop.waitForURL((url) => !url.pathname.startsWith("/pair"), { timeout: 20000 });
      await desktop.goto("/admin/devices");
      await expect(desktop.getByTestId("devices-connection-current")).toHaveText("Another Amiro", {
        timeout: 15000,
      });
      await expect(desktop.getByTestId("devices-connection")).toContainText(remote);
      await snap(desktop, testInfo, "desktop-connected.png");
      await page.goto("/admin/devices");
      await expect(
        page.getByTestId("devices-list-item").filter({ hasText: "Desktop app" }),
      ).toBeVisible({ timeout: 15000 });
    });

    await step("The desktop app: Switch back to this computer → This computer again, still signed in", async () => {
      await desktop.getByTestId("devices-switch-back").click();
      await desktop.waitForURL((url) => url.pathname !== "/admin/devices");
      await desktop.goto("/admin/devices");
      await expect(desktop.getByTestId("devices-connection-current")).toHaveText("This computer", {
        timeout: 15000,
      });
      await expect(desktop).not.toHaveURL(/sign-in/);
      await snap(desktop, testInfo, "desktop-switched-back.png");
    });

    await step("Clean up: remove the desktop app and turn phone access off", async () => {
      const { body } = await amiro.api<{ devices: { id: string }[] }>("/api/devices");
      for (const device of body.devices) {
        await amiro.api(`/api/devices/${device.id}`, { method: "DELETE" });
      }
      await amiro.api("/api/devices/remote-access", {
        method: "PUT",
        body: JSON.stringify({ enabled: false }),
      });
      await desktop.context().close();
    });
  });
});
