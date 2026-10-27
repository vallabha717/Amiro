/**
 * Journey 3 — Admin → Voice & Speech, a three-step flow:
 *   1. connect a provider for speaking (TTS) and for listening (STT)
 *   2. choose the model of each
 *   3. audition voices, then keep one
 * Settings are verified after a reload and against /api/voice/settings.
 */
import { expect, need, test } from "../support/fixtures";

type VoiceSettings = Record<string, unknown>;

test.describe("voice", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/admin/voice");
    await expect(page.getByRole("heading", { name: "Voice & Speech", level: 1 })).toBeVisible();
  });

  test("providers, models, voice: the three-step voice setup", async ({ page, step, note, amiro }) => {
    const { voice } = amiro.cfg;
    const tts = page.getByTestId("voice-tts-provider-panel");
    const stt = page.getByTestId("voice-stt-provider-panel");

    await step("Three ordered steps: providers, models, voice", async () => {
      await expect(page.getByRole("heading", { name: "Connect providers" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Choose models" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Choose a voice" })).toBeVisible();
    });

    await step("The hero shows the current voice and a Hear it button", async () => {
      await expect(page.getByTestId("voice-hero")).toBeVisible();
      await expect(page.getByTestId("voice-hero-name")).not.toBeEmpty();
      await expect(page.getByTestId("voice-hero-play")).toBeVisible();
    });

    await step("Fresh instance: no key field claims a key is already saved", async () => {
      const claims = await page.getByPlaceholder(/saved\. Paste a new key/).count();
      if (claims) note(`A fresh instance shows "saved" on ${claims} key field(s) though no key was ever saved.`);
      expect.soft(claims, "no key has been saved yet on a fresh instance").toBe(0);
    });

    await step(`Step 1 · Speaking: select ${voice.ttsEngine}`, async () => {
      await tts.getByRole("button", { name: new RegExp(`^${voice.ttsEngine}`) }).first().click();
      await expect(page.getByTestId("voice-tts-key")).toBeVisible();
    });

    await step(
      voice.ttsApiKey ? "Paste the speaking key (masked) and connect" : "No voice.ttsApiKey configured: key step skipped",
      async () => {
        if (!voice.ttsApiKey) {
          note("voice.ttsApiKey is empty: the speaking key was not exercised.", "info");
          return;
        }
        await page.getByTestId("voice-tts-key").fill(voice.ttsApiKey);
        await page.getByTestId("voice-tts-connect").click();
        await expect(page.getByText("Provider saved").first()).toBeVisible();
        expect(await page.locator("body").innerText()).not.toContain(voice.ttsApiKey);
      },
    );

    await step(`Step 1 · Listening: select ${voice.sttEngine}`, async () => {
      await stt.getByRole("button", { name: new RegExp(`^${voice.sttEngine}`) }).first().click();
      const key = voice.sttApiKey || voice.ttsApiKey;
      if (!key) return note("No STT key configured: listening key step skipped.", "info");
      await page.getByTestId("voice-stt-key").fill(key);
      await page.getByTestId("voice-stt-connect").click();
      await expect(page.getByText("Provider saved").first()).toBeVisible();
    });

    await step("Step 2 stays usable only with a connected provider", async () => {
      if (!voice.ttsApiKey) {
        // Without a key the active engine is still the free browser one: models are not selectable.
        await expect(page.getByTestId("voice-tts-model-panel")).toContainText("runs in your browser");
        return;
      }
      await expect(page.getByTestId("voice-step-models")).toHaveAttribute("data-state", "done");
      await expect(page.getByTestId("voice-tts-model")).toBeVisible();
    });

    await step("Settings survive a reload and match the API", async () => {
      await page.reload();
      const { body } = await amiro.api<VoiceSettings>("/api/voice/settings");
      expect.soft(JSON.stringify(body).toLowerCase(), "TTS provider should be ElevenLabs").toContain("elevenlabs");
    });
  });

  test("voice: audition voices, play a preview and keep one", async ({ page, step, amiro }) => {
    need(amiro.cfg.voice.ttsApiKey, "voice.ttsApiKey (needed to list and preview ElevenLabs voices)");
    await step("Step 3 lists the voices of the connected engine", async () => {
      const picker = page.getByTestId("voice-picker");
      await expect(picker).toBeVisible();
      await expect(picker.locator("li").first()).toBeVisible({ timeout: 30000 });
    });
    await step("Play a preview → audio is synthesized", async () => {
      const synth = page.waitForResponse((r) => r.url().includes("/api/tts/synthesize"), { timeout: 60000 });
      await page.getByTestId("voice-picker").locator("li").first().getByRole("button", { name: /Play preview/ }).click();
      const res = await synth;
      expect(res.status()).toBe(200);
      expect(res.headers()["content-type"] ?? "").toMatch(/audio|octet|json/);
    });
    await step("Use the voice", async () => {
      const wanted = amiro.cfg.voice.ttsVoiceId;
      const item = wanted
        ? page.getByTestId(`voice-option-${wanted}`)
        : page.getByTestId("voice-picker").locator("li").first();
      await item.getByRole("button", { name: /^Use$/ }).click();
      await expect(page.getByText(/Voice set to/)).toBeVisible();
    });
  });

  test("only English, Hindi and auto-detect are offered as listening languages", async ({ page, step }) => {
    await step("Step 2 lists exactly English, Hindi, Auto-detect", async () => {
      for (const name of ["English", /Hindi/, /Auto-detect/]) {
        await expect(page.getByTestId("voice-stt-model-panel").getByRole("button", { name }).first()).toBeVisible();
      }
      for (const gone of [/Spanish/, /French/, /Japanese/, /Korean/, /Chinese/]) {
        await expect(page.getByRole("button", { name: gone })).toHaveCount(0);
      }
    });
    await step("Pick Hindi", async () => {
      await page.getByTestId("voice-language-hi").click();
      await expect(page.getByText("Listening language saved")).toBeVisible();
    });
  });

  test("read-aloud preferences, speed and listening language persist", async ({ page, step, amiro }) => {
    await step("Turn on automatic narration", async () => {
      const auto = page.getByRole("switch", { name: "Read replies automatically" });
      if ((await auto.getAttribute("aria-checked")) !== "true") await auto.click();
      await expect(page.getByText("Preference saved").first()).toBeVisible();
    });
    await step("Set playback speed to 1.25x with the keyboard", async () => {
      const slider = page.getByRole("slider", { name: "Playback speed" });
      await slider.focus();
      for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowRight");
      await expect(page.getByText(/1\.\d\dx/).first()).toBeVisible();
    });
    await step("Listening language → Auto-detect", async () => {
      await page.getByTestId("voice-language-multi").click();
      await expect(page.getByText("Listening language saved")).toBeVisible();
    });
    await step("Reload: automatic narration and language are remembered", async () => {
      await page.reload();
      await expect(page.getByRole("switch", { name: "Read replies automatically" })).toHaveAttribute("aria-checked", "true");
      const { body } = await amiro.api<VoiceSettings>("/api/voice/settings");
      expect.soft(JSON.stringify(body)).toMatch(/multi|auto/i);
    });
    await step("Turn automatic narration back off (keeps later videos quiet)", async () => {
      await page.getByRole("switch", { name: "Read replies automatically" }).click();
    });
  });
});
