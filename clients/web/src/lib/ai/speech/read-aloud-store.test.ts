import * as voiceApi from "@/lib/backend/voice-api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SILENT_WAV,
  _resetAudioForTesting,
  getCurrentUtterance,
  stripMarkdownForSpeech,
  unlockAudio,
  useMessageReadAloudStore,
} from "./read-aloud-store";

describe("stripMarkdownForSpeech", () => {
  it("removes reasoning and thinking blocks completely", () => {
    const input =
      "<thinking>Need to explain recursion cleanly.</thinking>Here is how recursion works.";
    expect(stripMarkdownForSpeech(input)).toBe("Here is how recursion works.");

    const withThought =
      "<thought>Internal processing</thought>Recursion is a function that calls itself.";
    expect(stripMarkdownForSpeech(withThought)).toBe(
      "Recursion is a function that calls itself.",
    );
  });

  it("removes code fences and preserves surrounding prose", () => {
    const input = `Here is an example:
\`\`\`typescript
function add(a: number, b: number): number {
  return a + b;
}
\`\`\`
It takes two numbers and returns their sum.`;
    const cleaned = stripMarkdownForSpeech(input);
    expect(cleaned).toContain("Here is an example:");
    expect(cleaned).toContain("It takes two numbers and returns their sum.");
    expect(cleaned).not.toContain("function add");
  });

  it("unwraps inline code, bold, italics, and strikethrough", () => {
    const input =
      "Use `console.log` with **important** and *emphasized* and ~~outdated~~ terms.";
    expect(stripMarkdownForSpeech(input)).toBe(
      "Use console.log with important and emphasized and outdated terms.",
    );
  });

  it("preserves link text and removes image tags", () => {
    const input =
      "Check out [our documentation](https://example.com/docs) and ![Logo](https://example.com/logo.png).";
    expect(stripMarkdownForSpeech(input)).toBe(
      "Check out our documentation and .",
    );
  });

  it("strips headers, list bullets, and blockquotes cleanly", () => {
    const input = `### Summary of Steps
> Note: Follow these carefully
- First item
- Second item
1. Step one
2. Step two`;
    const cleaned = stripMarkdownForSpeech(input);
    expect(cleaned).toContain("Summary of Steps");
    expect(cleaned).toContain("Note: Follow these carefully");
    expect(cleaned).toContain("First item");
    expect(cleaned).toContain("Second item");
    expect(cleaned).toContain("Step one");
    expect(cleaned).toContain("Step two");
    expect(cleaned).not.toContain("###");
    expect(cleaned).not.toContain(">");
    expect(cleaned).not.toContain("- ");
  });

  it("returns empty string when given empty or null-like input", () => {
    expect(stripMarkdownForSpeech("")).toBe("");
  });
});

describe("useMessageReadAloudStore", () => {
  let mockSpeak: any;
  let mockCancel: any;
  let mockAudioPlay: any;
  let mockAudioPause: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockSpeak = vi.fn();
    mockCancel = vi.fn();
    mockAudioPlay = vi.fn().mockResolvedValue(undefined);
    mockAudioPause = vi.fn();

    // Set up window and browser APIs for Node test environment
    const mockWindow = {
      speechSynthesis: {
        speak: mockSpeak,
        cancel: mockCancel,
      },
      localStorage: {
        getItem: vi.fn(),
        setItem: vi.fn(),
        removeItem: vi.fn(),
      },
    };
    (globalThis as any).window = mockWindow;

    (globalThis as any).SpeechSynthesisUtterance = class {
      text: string;
      rate: number = 1;
      onstart: (() => void) | null = null;
      onend: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(text: string) {
        this.text = text;
      }
    };

    (globalThis as any).Audio = vi.fn().mockImplementation(() => ({
      play: mockAudioPlay,
      pause: mockAudioPause,
      currentTime: 0,
      src: "",
      onplay: null,
      onended: null,
      onerror: null,
    }));

    (globalThis as any).URL = {
      createObjectURL: vi.fn().mockReturnValue("blob:mock-url"),
      revokeObjectURL: vi.fn(),
    };

    _resetAudioForTesting();
    useMessageReadAloudStore.getState().stop();

    // Reset default voice settings
    vi.spyOn(voiceApi, "getCachedVoiceSettings").mockReturnValue({
      readAloudEnabled: true,
      autoReadAloud: false,
      ttsProvider: "browser-native",
      sttProvider: "browser-native",
      sttLanguage: "en",
      ttsProviders: {
        "browser-native": {
          model: "browser-default",
          voiceId: "default",
          baseUrl: "",
          speed: 1.0,
          configured: true,
        },
        openai: {
          model: "tts-1",
          voiceId: "alloy",
          baseUrl: "https://api.openai.com/v1",
          speed: 1.0,
          configured: true,
        },
      },
      sttProviders: {},
    });
  });

  it("starts in idle state and stops properly", () => {
    const store = useMessageReadAloudStore.getState();
    expect(store.messageId).toBeNull();
    expect(store.status).toBe("idle");

    store.stop();
    expect(mockCancel).toHaveBeenCalled();
  });

  it("plays message with browser-native speech synthesis when configured", async () => {
    const store = useMessageReadAloudStore.getState();
    await store.playMessage({
      messageId: "msg-1",
      text: "Hello world!",
    });

    expect(mockSpeak).toHaveBeenCalledTimes(1);
    expect(useMessageReadAloudStore.getState().messageId).toBe("msg-1");
    expect(getCurrentUtterance()).toBeDefined();
  });

  it("toggles off when called on the currently active message", async () => {
    const store = useMessageReadAloudStore.getState();
    await store.playMessage({
      messageId: "msg-1",
      text: "Hello world!",
    });

    // Toggling the same message should stop it
    await store.toggle({
      messageId: "msg-1",
      text: "Hello world!",
    });

    expect(useMessageReadAloudStore.getState().status).toBe("idle");
    expect(useMessageReadAloudStore.getState().messageId).toBeNull();
  });

  it("falls back to window.speechSynthesis when cloud synthesis throws an error", async () => {
    // Set active provider to OpenAI
    vi.spyOn(voiceApi, "getCachedVoiceSettings").mockReturnValue({
      readAloudEnabled: true,
      autoReadAloud: false,
      ttsProvider: "openai",
      sttProvider: "browser-native",
      sttLanguage: "en",
      ttsProviders: {
        openai: {
          model: "tts-1",
          voiceId: "alloy",
          baseUrl: "https://api.openai.com/v1",
          speed: 1.0,
          configured: true,
        },
      },
      sttProviders: {},
    });

    // Mock synthesizeSpeech failure
    vi.spyOn(voiceApi, "synthesizeSpeech").mockRejectedValue(
      new Error("Network Error"),
    );

    const store = useMessageReadAloudStore.getState();
    await store.playMessage({
      messageId: "msg-fallback",
      text: "Testing fallback mechanism",
    });

    // Should have attempted synthesis and fallen back to window.speechSynthesis
    expect(mockSpeak).toHaveBeenCalledTimes(1);
    expect(useMessageReadAloudStore.getState().messageId).toBe("msg-fallback");
  });

  it("unlockAudio primes the audio element with silent wav", () => {
    expect(SILENT_WAV).toContain("audio/wav");
    unlockAudio();
    expect(mockAudioPlay).toHaveBeenCalled();
  });
});
