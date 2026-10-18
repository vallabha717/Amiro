import {
  getCachedVoiceSettings,
  synthesizeSpeech,
} from "@/lib/backend/voice-api";
import { create } from "zustand";

export type ReadAloudStatus = "idle" | "loading" | "playing";

export interface ReadAloudState {
  messageId: string | null;
  status: ReadAloudStatus;
  toggle: (payload: { messageId: string; text: string }) => Promise<void>;
  playMessage: (payload: { messageId: string; text: string }) => Promise<void>;
  stop: () => void;
}

export const SILENT_WAV =
  "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA";

export function stripMarkdownForSpeech(text: string): string {
  if (!text) return "";
  let clean = text;

  // Remove <thinking>...</thinking> and other reasoning blocks
  clean = clean.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "");
  clean = clean.replace(/<thought>[\s\S]*?<\/thought>/gi, "");

  // Remove other HTML tags
  clean = clean.replace(/<[^>]+>/g, "");

  // Remove code blocks ```...```
  clean = clean.replace(/```[\s\S]*?```/g, " ");

  // Remove inline code backticks: `code` -> code
  clean = clean.replace(/`([^`]+)`/g, "$1");

  // Remove images: ![alt](url) -> ""
  clean = clean.replace(/!\[([^\]]*)\]\([^)]*\)/g, "");

  // Convert links: [text](url) -> text
  clean = clean.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");

  // Remove Markdown headings: # Heading -> Heading
  clean = clean.replace(/^#{1,6}\s+/gm, "");

  // Remove blockquotes: > quote -> quote
  clean = clean.replace(/^\s*>\s+/gm, "");

  // Remove unordered list bullets: * or - or + item -> item
  clean = clean.replace(/^\s*[-*+]\s+/gm, "");

  // Remove ordered list numbers: 1. item -> item
  clean = clean.replace(/^\s*\d+\.\s+/gm, "");

  // Remove bold/italics markers: **text**, *text*, __text__, _text_, ~~text~~
  clean = clean.replace(/(\*\*|__)(.*?)\1/g, "$2");
  clean = clean.replace(/(\*|_)(.*?)\1/g, "$2");
  clean = clean.replace(/~~(.*?)~~/g, "$1");

  // Remove horizontal rules
  clean = clean.replace(/^[-*_]{3,}\s*$/gm, "");

  // Remove table rows: lines starting and ending with |
  clean = clean.replace(/^\s*\|.*\|\s*$/gm, " ");

  // Normalize whitespace: collapse multiple newlines and spaces
  clean = clean.replace(/\r\n/g, "\n");
  clean = clean.replace(/\n{2,}/g, ". ");
  clean = clean.replace(/\n/g, " ");
  clean = clean.replace(/\s{2,}/g, " ");

  return clean.trim();
}

let sharedAudio: HTMLAudioElement | null = null;
let currentBlobUrl: string | null = null;
let currentUtterance: SpeechSynthesisUtterance | null = null;

function getSharedAudio(): HTMLAudioElement | null {
  if (typeof window === "undefined") return null;
  if (!sharedAudio) {
    sharedAudio = new Audio();
  }
  return sharedAudio;
}

export function unlockAudio(): void {
  if (typeof window === "undefined") return;
  const audio = getSharedAudio();
  if (audio) {
    audio.src = SILENT_WAV;
    audio.play().catch(() => {});
  }
}

export function _resetAudioForTesting(): void {
  sharedAudio = null;
  currentBlobUrl = null;
  currentUtterance = null;
}

export function getCurrentUtterance(): SpeechSynthesisUtterance | null {
  return currentUtterance;
}

function cleanupBlob(): void {
  if (currentBlobUrl && typeof window !== "undefined") {
    URL.revokeObjectURL(currentBlobUrl);
    currentBlobUrl = null;
  }
}

export const useMessageReadAloudStore = create<ReadAloudState>((set, get) => ({
  messageId: null,
  status: "idle",

  stop: () => {
    if (typeof window !== "undefined" && window.speechSynthesis) {
      window.speechSynthesis.cancel();
      currentUtterance = null;
    }
    const audio = getSharedAudio();
    if (audio) {
      audio.pause();
      audio.currentTime = 0;
      audio.onplay = null;
      audio.onended = null;
      audio.onerror = null;
    }
    cleanupBlob();
    set({ messageId: null, status: "idle" });
  },

  toggle: async ({ messageId, text }) => {
    const state = get();
    if (state.messageId === messageId && state.status !== "idle") {
      state.stop();
    } else {
      await state.playMessage({ messageId, text });
    }
  },

  playMessage: async ({ messageId, text }) => {
    const { stop } = get();
    stop();

    const cleanText = stripMarkdownForSpeech(text);
    if (!cleanText) {
      return;
    }

    set({ messageId, status: "loading" });

    const settings = getCachedVoiceSettings();
    const providerId = settings.ttsProvider || "browser-native";
    const providerState = settings.ttsProviders[providerId];
    const speed = providerState?.speed || 1.0;

    const playNativeSpeech = () => {
      if (typeof window === "undefined" || !window.speechSynthesis) {
        set({ messageId: null, status: "idle" });
        return;
      }
      try {
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(cleanText);
        utterance.rate = speed;
        currentUtterance = utterance;

        utterance.onstart = () => {
          if (get().messageId === messageId) {
            set({ status: "playing" });
          }
        };
        utterance.onend = () => {
          if (get().messageId === messageId) {
            set({ messageId: null, status: "idle" });
          }
        };
        utterance.onerror = () => {
          if (get().messageId === messageId) {
            set({ messageId: null, status: "idle" });
          }
        };

        window.speechSynthesis.speak(utterance);
      } catch {
        set({ messageId: null, status: "idle" });
      }
    };

    if (providerId === "browser-native") {
      playNativeSpeech();
      return;
    }

    try {
      const blob = await synthesizeSpeech({
        text: cleanText,
        provider: providerId,
        model: providerState?.model,
        voiceId: providerState?.voiceId,
        baseUrl: providerState?.baseUrl,
        speed: providerState?.speed,
      });

      if (typeof window === "undefined") {
        set({ messageId: null, status: "idle" });
        return;
      }

      cleanupBlob();
      const url = URL.createObjectURL(blob);
      currentBlobUrl = url;

      const audio = getSharedAudio();
      if (!audio) {
        set({ messageId: null, status: "idle" });
        return;
      }

      audio.src = url;
      audio.playbackRate = speed;

      audio.onplay = () => {
        if (get().messageId === messageId) {
          set({ status: "playing" });
        }
      };

      audio.onended = () => {
        cleanupBlob();
        if (get().messageId === messageId) {
          set({ messageId: null, status: "idle" });
        }
      };

      audio.onerror = () => {
        cleanupBlob();
        // If audio element fails to play, attempt browser-native speech fallback
        playNativeSpeech();
      };

      await audio.play();
    } catch {
      // Backend unavailable / synthesis error: fallback to browser-native speech
      playNativeSpeech();
    }
  },
}));
