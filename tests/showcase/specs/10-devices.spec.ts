/**
 * Scene: connect a phone. Turn on phone access, open the address on the
 * phone, get a code, approve it in Admin → Devices; the phone signs in with
 * its own session and no password. The phone is recorded in its own context
 * and export-media.mjs overlays it picture-in-picture on the computer.
 */
import * as path from "node:path";
import { loadConfig } from "../../e2e/support/config";
import { expect, hold, scene, test } from "../support";

const cfg = loadConfig();
const remotePort = cfg.target.port + 2;
const remote = `http://127.0.0.1:${remotePort}`;
const PHONE = { width: 390, height: 844 };

test("devices: pair a phone with a code", async ({ page, step, browser, videoClock }, testInfo) => {
  scene("devices");

  await step("Admin → Devices → turn on \"Allow phones on my network\" → address and QR code", async () => {
    await page.goto("/admin/devices");
    await hold(page, 1500);
    await page.getByTestId("devices-phone-access-port").fill(String(remotePort));
    await page.getByTestId("devices-phone-access-switch").click();
    await expect(page.getByTestId("devices-connect-qr")).toBeVisible({ timeout: 15000 });
    await hold(page, 2500);
  });

  const phoneCtx = await browser.newContext({
    viewport: PHONE,
    recordVideo: { dir: path.join(testInfo.outputDir, "phone"), size: PHONE },
    isMobile: true,
    hasTouch: true,
  });
  const phoneStart = videoClock.now();
  const phone = await phoneCtx.newPage();

  let code = "";
  await step("On the phone (right): open the address from the QR → name it → Get a code", async () => {
    await phone.goto(`${remote}/pair`);
    await phone.getByTestId("pair-name-input").pressSequentially("Priya's phone", { delay: 60 });
    await phone.getByTestId("pair-submit").click();
    code = (await phone.getByTestId("pair-user-code").innerText()).trim();
    await hold(page, 2500);
  });

  await step(`On the computer: the request shows the same code (${code || "XXXX-XXXX"}) → Approve`, async () => {
    const request = page.getByTestId("devices-request").filter({ hasText: code });
    await expect(request).toBeVisible({ timeout: 15000 });
    await hold(page, 2000);
    await request.getByTestId("devices-request-approve").click();
  });

  await step("The phone connects by itself — its own sign-in, no password typed", async () => {
    await phone.waitForURL((url) => url.port === String(remotePort) && url.pathname !== "/pair", { timeout: 30000 });
    await hold(page, 4000);
  });

  await step("Paired devices lists the phone; remove it any time", async () => {
    await page.reload();
    await expect(page.getByTestId("devices-list-item").filter({ hasText: "Priya's phone" })).toBeVisible();
    await hold(page, 3500);
  });

  const video = phone.video();
  await phoneCtx.close();
  if (video) {
    testInfo.annotations.push({
      type: "showcase-pip",
      description: JSON.stringify({ path: await video.path(), offsetMs: phoneStart }),
    });
  }
  await page.getByTestId("devices-phone-access-switch").click();
});
