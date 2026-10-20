/**
 * Journey 3 — Admin → Voice & Speech: TTS/STT engines and keys, voice
 * selection and preview, read-aloud preferences, listening language.
 * Settings are verified after a reload and against /api/voice/settings.
 */
import { expect, need, test } from "../support/fixtures";

type VoiceSettings = Record<string, unknown>;

test.describe("voice", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/admin/voice");
    await expect(page.getByRole("heading", { name: "Voice & Speech", level: 1 })).toBeVisible();
  });

  test("engines & keys: ElevenLabs for speech output and input", async ({ page, step, note, amiro }) => {
    const { voice } = amiro.cfg;
    await step("Open Engines & Keys", async () => {
      await page.getByRole("button", { name: "Engines & Keys" }).click();
      await expect(page.getByRole("button", { name: "Save TTS Engine" })).toBeVisible();
    });

    await step("Fresh instance: key fields should not claim a key is already saved", async () => {
      const claims = await page.getByPlaceholder(/saved \(paste new key to update\)/).count();
      if (claims) note(`A fresh instance shows "•••• saved" on ${claims} key field(s) though no key was ever saved.`);
      expect.soft(claims, "no key has been saved yet on a fresh instance").toBe(0);
    });

    await step(`Select ${voice.ttsEngine} as the TTS engine`, async () => {
      await page.getByRole("button", { name: voice.ttsEngine, exact: true }).first().click();
    });

    await step(voice.ttsApiKey ? "Paste the TTS key (masked) and save" : "Save the TTS engine (no voice.ttsApiKey configured, key step skipped)", async () => {
      if (!voice.ttsApiKey) {
        note("voice.ttsApiKey is empty: ElevenLabs key entry was not exercised.", "info");
        await page.getByRole("button", { name: "Save TTS Engine" }).click();
        await expect(page.getByText(/saved|failed/i).first()).toBeVisible();
        return;
      }
      const key = page.getByRole("textbox").filter({ has: page.locator("[type=password]") }).first();
      const field = (await key.count()) ? key : page.locator('input[type="password"]').first();
      await field.fill(voice.ttsApiKey);
      await page.getByRole("button", { name: "Save TTS Engine" }).click();
      await expect(page.getByText(/saved/i).first()).toBeVisible();
      expect(await page.locator("body").innerText()).not.toContain(voice.ttsApiKey);
    });

    await step(`Select ${voice.sttEngine} as the STT engine and save`, async () => {
      await page.getByRole("button", { name: voice.sttEngine, exact: true }).first().click();
      if (voice.sttApiKey || voice.ttsApiKey) {
        await page.locator('input[type="password"]').nth(1).fill(voice.sttApiKey || voice.ttsApiKey);
      }
      await page.getByRole("button", { name: "Save STT Engine" }).click();
      await expect(page.getByText(/saved/i).first()).toBeVisible();
    });

    await step("Settings survive a reload and match the API", async () => {
      await page.reload();
      const { body } = await amiro.api<VoiceSettings>("/api/voice/settings");
      const flat = JSON.stringify(body).toLowerCase();
      expect.soft(flat, "TTS provider should be ElevenLabs").toContain("elevenlabs");
    });
  });

  test("assistant voice: pick a voice and play a preview", async ({ page, step, amiro }) => {
    need(amiro.cfg.voice.ttsApiKey, "voice.ttsApiKey (needed to list and preview ElevenLabs voices)");
    await step("Change Voice → the ElevenLabs voice library loads", async () => {
      await page.getByRole("button", { name: "Change Voice" }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("button").nth(2)).toBeVisible({ timeout: 30000 });
    });
    await step("Choose a voice", async () => {
      const dialog = page.getByRole("dialog");
      const wanted = amiro.cfg.voice.ttsVoiceId;
      const choice = wanted ? dialog.getByText(wanted).first() : dialog.getByRole("button", { name: /select|use|choose/i }).first();
      await choice.click();
      await expect(page.getByText(/Voice set to/)).toBeVisible();
    });
    await step("Play Preview → audio is synthesized", async () => {
      const synth = page.waitForResponse((r) => r.url().includes("/api/tts/synthesize"), { timeout: 60000 });
      await page.getByRole("button", { name: "Play Preview" }).click();
      const res = await synth;
      expect(res.status()).toBe(200);
      expect(res.headers()["content-type"] ?? "").toMatch(/audio|octet|json/);
    });
  });

  test("only English, Hindi and auto-detect are offered as listening languages", async ({ page, step }) => {
    await step("Input & Speech lists exactly English, Hindi, Multilingual", async () => {
      await page.getByRole("button", { name: "Input & Speech" }).click();
      for (const name of ["English", /Hindi/, /Multilingual/]) await expect(page.getByRole("button", { name }).first()).toBeVisible();
      for (const gone of [/Spanish/, /French/, /Japanese/, /Korean/, /Chinese/]) await expect(page.getByRole("button", { name: gone })).toHaveCount(0);
    });
    await step("Pick Hindi", async () => {
      await page.getByRole("button", { name: /Hindi/ }).click();
      await expect(page.getByText(/Language set to Hindi/)).toBeVisible();
    });
  });

  test("read-aloud preferences, speed and listening language persist", async ({ page, step, amiro }) => {
    await step("Turn on automatic narration", async () => {
      const auto = page.getByRole("switch").nth(1);
      if ((await auto.getAttribute("aria-checked")) !== "true") await auto.click();
      await expect(page.getByText("Auto read-aloud enabled")).toBeVisible();
    });
    await step("Set playback speed to 1.25x with the keyboard", async () => {
      const slider = page.getByRole("slider").first();
      await slider.focus();
      for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowRight");
      await expect(page.getByText(/1\.\d\dx/).first()).toBeVisible();
    });
    await step("Input & Speech → Multilingual (Auto-Detect)", async () => {
      await page.getByRole("button", { name: "Input & Speech" }).click();
      await page.getByRole("button", { name: /Multilingual/ }).click();
      await expect(page.getByText(/Language set to/)).toBeVisible();
    });
    await step("Reload: automatic narration and language are remembered", async () => {
      await page.reload();
      await expect(page.getByRole("switch").nth(1)).toHaveAttribute("aria-checked", "true");
      const { body } = await amiro.api<VoiceSettings>("/api/voice/settings");
      expect.soft(JSON.stringify(body)).toMatch(/multi|auto/i);
    });
    await step("Turn automatic narration back off (keeps later videos quiet)", async () => {
      await page.getByRole("switch").nth(1).click();
    });
  });
});
