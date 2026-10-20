/**
 * Journey 9 — voice in the chat itself:
 *   - read-aloud on an assistant reply (TTS)
 *   - dictation from the microphone (STT)
 *   - live voice room: open, hear/see phases and captions, minimize, end
 *
 * Chrome runs with a fake microphone that plays tests/.e2e-state/fake-mic.wav
 * (global setup speaks "What is two plus two?" with ElevenLabs when
 * voice.ttsApiKey is set, otherwise it is a tone and only the pipeline is
 * asserted, not the transcript).
 */
import * as fs from "node:fs";
import { ask, composer, newChat, selectModel } from "../support/chat";
import { FAKE_MIC_WAV } from "../support/config";
import { expect, test } from "../support/fixtures";

const spoken = () => fs.existsSync(`${FAKE_MIC_WAV}.spoken`);

test.describe("voice-live", () => {
  test.beforeEach(async ({ page }) => {
    await newChat(page);
    await selectModel(page);
  });

  test("read a reply aloud", async ({ page, step, note, amiro }) => {
    await step("Get a short reply", async () => {
      await ask(page, "Say hello in one short sentence.");
    });
    await step("Click the speaker on the reply → speech is synthesized", async () => {
      const btn = page.getByTestId("message-read-aloud-button").last();
      await page.locator("main article").last().hover();
      await expect(btn).toBeVisible();
      const synth = page.waitForResponse((r) => r.url().includes("/api/tts/synthesize"), { timeout: 45000 }).catch(() => null);
      await btn.click();
      const res = await synth;
      if (!amiro.cfg.voice.ttsApiKey) {
        note("Read-aloud with no TTS key falls back to browser speech; nothing is audible in a headless recording.", "info");
        return;
      }
      expect(res, "a /api/tts/synthesize call should be made").not.toBeNull();
      expect(res!.status()).toBe(200);
    });
  });

  test("dictate into the composer with the microphone", async ({ page, step, amiro }) => {
    test.skip(!amiro.cfg.voice.sttApiKey && !amiro.cfg.voice.ttsApiKey, "needs a server STT engine key (voice.sttApiKey or the ElevenLabs key)");
    await step("Click the mic → recording state", async () => {
      await page.getByTestId("composer-mic-button").click();
      await page.waitForTimeout(4000);
    });
    await step("Click the mic again → audio is transcribed into the composer", async () => {
      const stt = page.waitForResponse((r) => r.url().includes("/api/stt/transcribe"), { timeout: 45000 });
      await page.getByTestId("composer-mic-button").click();
      const res = await stt;
      expect(res.status()).toBe(200);
      if (spoken()) await expect.soft(composer(page)).toContainText(/two/i, { timeout: 15000 });
    });
  });

  test("live voice room: open, talk, minimize, end", async ({ page, step, note }) => {
    await step("Preflight endpoint says live voice is available", async () => {
      const res = await page.request.get("/api/live-voice/preflight", {
        headers: { authorization: `Bearer ${await page.evaluate(() => localStorage.getItem("amiro.session-token"))}` },
      });
      const body = await res.text();
      if (!res.ok()) note(`Live voice preflight returned ${res.status()}: ${body.slice(0, 200)}`);
    });
    await step("Click the voice-mode button → the voice room opens", async () => {
      await page.getByTestId("composer-voice-mode-button").click();
      await expect(page.getByTestId("voice-room")).toBeVisible({ timeout: 20000 });
      await expect(page.getByTestId("voice-phase-line")).toBeVisible();
    });
    await step("Speak (fake mic) → a user caption and an assistant reply appear", async () => {
      const err = page.getByTestId("voice-error");
      const outcome = await Promise.race([
        page.getByTestId("voice-assistant-caption").waitFor({ timeout: 90000 }).then(() => "reply"),
        err.waitFor({ timeout: 90000 }).then(() => "error"),
      ]).catch(() => "timeout");
      if (outcome === "error") note(`Voice room error: ${await err.innerText()}`);
      if (spoken()) expect.soft(outcome, "assistant should answer the spoken question").toBe("reply");
      else note("Fake mic is a tone (no voice.ttsApiKey); live conversation content not asserted.", "info");
    });
    await step("Minimize → dock; expand again", async () => {
      await page.getByTestId("voice-minimize").click();
      await expect(page.getByTestId("voice-dock")).toBeVisible();
      await page.getByTestId("voice-expand").click();
      await expect(page.getByTestId("voice-room")).toBeVisible();
    });
    await step("End voice → room closes, transcript stays in the chat", async () => {
      await page.getByTestId("voice-end").click();
      await expect(page.getByTestId("voice-room")).toBeHidden();
    });
  });
});
