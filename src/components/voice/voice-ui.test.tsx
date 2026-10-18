import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  BAND_VOICE,
  DEFAULT_MESH_TUNING,
  MESH_INLINE_TUNING,
  meshDisplacement,
} from "./voice-waves";
import { VoiceComposerBar, VoiceSessionPill } from "./voice-composer-bar";
import { LiveVoiceStage } from "@/components/chat-bot-voice";

describe("Voice UI Components", () => {
  describe("BAND_VOICE and Wave Constants", () => {
    it("exports high-contrast listening and responding ink parameters", () => {
      expect(BAND_VOICE.listening.color).toBe("#FFFFFF");
      expect(BAND_VOICE.listening.peakOpacity).toBeGreaterThan(0);
      expect(BAND_VOICE.responding.color).toBe("#000000");
      expect(BAND_VOICE.responding.peakOpacity).toBeGreaterThan(0);
    });

    it("calculates smooth mesh displacement along the ribbon", () => {
      const d1 = meshDisplacement(0.2, 0.5, 1.0, 0, DEFAULT_MESH_TUNING);
      const d2 = meshDisplacement(0.8, 0.5, 1.0, 0, DEFAULT_MESH_TUNING);
      expect(typeof d1).toBe("number");
      expect(typeof d2).toBe("number");
      expect(Number.isFinite(d1)).toBe(true);
      expect(Number.isFinite(d2)).toBe(true);
    });

    it("has compact tuning for inline surfaces", () => {
      expect(MESH_INLINE_TUNING.lines).toBeLessThan(DEFAULT_MESH_TUNING.lines);
      expect(MESH_INLINE_TUNING.spread).toBeGreaterThan(DEFAULT_MESH_TUNING.spread);
    });
  });

  describe("VoiceComposerBar", () => {
    it("renders compact composer voice bar with all essential controls and band", () => {
      const html = renderToStaticMarkup(
        createElement(VoiceComposerBar, {
          phase: "listening",
          muted: false,
          outputMuted: false,
          assistantAudioActive: false,
          onToggleMute: () => {},
          onToggleOutputMute: () => {},
          onEnd: () => {},
          accentHex: "#4f46e5",
        }),
      );

      expect(html).toContain('data-testid="voice-composer-bar"');
      expect(html).toContain('data-testid="voice-session-band"');
      expect(html).toContain('data-testid="voice-mute-button"');
      expect(html).toContain('data-testid="voice-output-mute-button"');
      expect(html).toContain('data-testid="voice-end-button"');
    });

    it("renders mic off icon when muted", () => {
      const html = renderToStaticMarkup(
        createElement(VoiceComposerBar, {
          phase: "listening",
          muted: true,
          outputMuted: false,
          assistantAudioActive: false,
          onToggleMute: () => {},
          onToggleOutputMute: () => {},
          onEnd: () => {},
          accentHex: "#4f46e5",
        }),
      );

      expect(html).toContain('aria-label="Unmute microphone"');
    });
  });

  describe("VoiceSessionPill", () => {
    it("returns null when voice session is inactive", () => {
      const html = renderToStaticMarkup(createElement(VoiceSessionPill, { active: false }));
      expect(html).toBe("");
    });

    it("renders header pill when voice session is active", () => {
      const html = renderToStaticMarkup(createElement(VoiceSessionPill, { active: true }));
      expect(html).toContain('data-testid="voice-session-pill"');
    });
  });

  describe("LiveVoiceStage", () => {
    it("renders expressive voice stage with character eyes and ambient captions", () => {
      const html = renderToStaticMarkup(
        createElement(LiveVoiceStage, {
          phase: "listening",
          partialTranscript: "Hello Amiro",
          assistantTranscript: "Hi there! I am listening.",
        }),
      );
      expect(html).toContain('data-testid="voice-room"');
      expect(html).toContain('data-testid="voice-room-eyes"');
      expect(html).toContain('data-testid="voice-ambient-user"');
      expect(html).toContain('data-testid="voice-ambient-assistant"');
      expect(html).toContain('data-testid="voice-mute-button"');
      expect(html).toContain('data-testid="voice-output-mute-button"');
      expect(html).toContain('data-testid="voice-wave-toggle-button"');
      expect(html).toContain('data-testid="voice-captions-toggle-button"');
      expect(html).toContain('data-testid="voice-minimize-button"');
      expect(html).toContain('data-testid="voice-end-button"');
    });
  });
});
