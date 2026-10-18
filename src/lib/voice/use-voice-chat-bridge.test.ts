import type { UIMessage } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildLiveVoiceWsUrl, createSeqFilter } from "./live-voice-client";
import { pcmFrameLevel, smoothLevel } from "./pcm-capture";
import { base64ToInt16, outputLevelFromRms } from "./tts-playback";
import {
  type BridgeDeps,
  VoiceBridgeController,
  assistantSpeechText,
} from "./use-voice-chat-bridge";

const asst = (id: string, ...texts: string[]): UIMessage => ({
  id,
  role: "assistant",
  parts: texts.map((text) => ({ type: "text", text })),
});
const user = (id: string, text: string): UIMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text }],
});

let deps: { [K in keyof BridgeDeps]: ReturnType<typeof vi.fn> };
let c: VoiceBridgeController;
beforeEach(() => {
  deps = {
    sendMessage: vi.fn(),
    stop: vi.fn(),
    speakDelta: vi.fn(),
    speakEnd: vi.fn(),
    markThinking: vi.fn(),
  };
  c = new VoiceBridgeController(deps as unknown as BridgeDeps);
});

describe("assistantSpeechText", () => {
  it("joins only text parts with blank lines", () => {
    const m: UIMessage = {
      id: "a",
      role: "assistant",
      parts: [
        { type: "reasoning", text: "thinking" },
        { type: "text", text: "One" },
        {
          type: "tool-bash",
          toolCallId: "1",
          state: "output-available",
          input: {},
          output: "x",
        },
        { type: "text", text: "Two" },
      ] as UIMessage["parts"],
    };
    expect(assistantSpeechText(m)).toBe("One\n\nTwo");
  });
});

describe("VoiceBridgeController", () => {
  it("never speaks messages that existed at activation", () => {
    c.sync([user("u0", "q"), asst("a0", "old answer")], "ready");
    c.sync([user("u0", "q"), asst("a0", "old answer")], "streaming");
    c.sync([user("u0", "q"), asst("a0", "old answer")], "ready");
    expect(deps.speakDelta).not.toHaveBeenCalled();
    expect(deps.speakEnd).not.toHaveBeenCalled();
  });

  it("streams suffix deltas then ends exactly once", () => {
    c.sync([], "ready");
    c.sync([user("u1", "hi"), asst("a1", "Hel")], "streaming");
    c.sync([user("u1", "hi"), asst("a1", "Hello wor")], "streaming");
    c.sync([user("u1", "hi"), asst("a1", "Hello world")], "streaming");
    expect(deps.speakDelta.mock.calls).toEqual([
      ["a1", "Hel"],
      ["a1", "lo wor"],
      ["a1", "ld"],
    ]);
    c.sync([user("u1", "hi"), asst("a1", "Hello world")], "ready");
    c.sync([user("u1", "hi"), asst("a1", "Hello world")], "ready");
    expect(deps.speakEnd.mock.calls).toEqual([["a1"]]);
  });

  it("sends the final suffix delivered together with the ready status", () => {
    c.sync([], "ready");
    c.sync([user("u1", "hi"), asst("a1", "Hi")], "streaming");
    c.sync([user("u1", "hi"), asst("a1", "Hi there")], "ready");
    expect(deps.speakDelta).toHaveBeenLastCalledWith("a1", " there");
    expect(deps.speakEnd).toHaveBeenCalledTimes(1);
  });

  it("utterance stops a running stream, sends message, marks thinking", () => {
    c.sync([], "ready");
    c.sync([user("u1", "hi"), asst("a1", "Hi")], "streaming");
    c.onUtterance("new question");
    expect(deps.stop).toHaveBeenCalled();
    expect(deps.sendMessage).toHaveBeenCalledWith({
      role: "user",
      parts: [{ type: "text", text: "new question" }],
    });
    expect(deps.markThinking).toHaveBeenCalled();
  });

  it("utterance while idle does not call stop", () => {
    c.sync([], "ready");
    c.onUtterance("q");
    expect(deps.stop).not.toHaveBeenCalled();
  });

  it("turn cancel stops the stream and suppresses further deltas and end", () => {
    c.sync([], "ready");
    c.sync([user("u1", "hi"), asst("a1", "Hi")], "streaming");
    c.onCancel("a1");
    expect(deps.stop).toHaveBeenCalled();
    c.sync([user("u1", "hi"), asst("a1", "Hi there")], "streaming");
    c.sync([user("u1", "hi"), asst("a1", "Hi there")], "ready");
    expect(deps.speakDelta).toHaveBeenCalledTimes(1);
    expect(deps.speakEnd).not.toHaveBeenCalled();
  });

  it("cancel with null turnId cancels the in-flight assistant message", () => {
    c.sync([], "ready");
    c.sync([user("u1", "hi"), asst("a1", "Hi")], "streaming");
    c.onCancel(null);
    c.sync([user("u1", "hi"), asst("a1", "Hi again")], "streaming");
    expect(deps.speakDelta).toHaveBeenCalledTimes(1);
  });

  it("a turn with no assistant text still releases the server once", () => {
    c.sync([], "ready");
    c.onUtterance("do something");
    c.sync([user("u1", "do something")], "submitted");
    c.sync([user("u1", "do something")], "ready");
    c.sync([user("u1", "do something")], "ready");
    expect(deps.speakEnd).toHaveBeenCalledTimes(1);
    expect(deps.speakEnd.mock.calls[0][0]).toMatch(/^empty-/);
  });

  it("an assistant message with only a tool part ends with speakEnd for its id", () => {
    c.sync([], "ready");
    c.onUtterance("run it");
    const tool: UIMessage = {
      id: "a1",
      role: "assistant",
      parts: [{ type: "step-start" }] as UIMessage["parts"],
    };
    c.sync([user("u1", "run it"), tool], "streaming");
    c.sync([user("u1", "run it"), tool], "ready");
    expect(deps.speakDelta).not.toHaveBeenCalled();
    expect(deps.speakEnd).toHaveBeenCalledWith("a1");
  });

  it("reset forgets the baseline so a later activation re-baselines", () => {
    c.sync([asst("a0", "x")], "ready");
    c.reset();
    c.sync([asst("a0", "x")], "ready");
    c.sync([asst("a0", "x"), asst("a1", "y z")], "streaming");
    expect(deps.speakDelta).toHaveBeenCalledTimes(1);
    expect(deps.speakDelta).toHaveBeenCalledWith("a1", "y z");
  });
});

describe("pure helpers", () => {
  it("buildLiveVoiceWsUrl converts schemes and adds ticket/token", () => {
    expect(
      buildLiveVoiceWsUrl("http://127.0.0.1:8787/api/live-voice", "T", "S"),
    ).toBe("ws://127.0.0.1:8787/api/live-voice?ticket=T&token=S");
    expect(buildLiveVoiceWsUrl("https://a.b/api/live-voice", "T", "")).toBe(
      "wss://a.b/api/live-voice?ticket=T",
    );
    expect(
      buildLiveVoiceWsUrl("/api/live-voice", "T", "", "https://x.y/page"),
    ).toBe("wss://x.y/api/live-voice?ticket=T");
  });

  it("createSeqFilter drops duplicates and out-of-order frames", () => {
    const ok = createSeqFilter();
    expect([1, 2, 2, 1, 5, 4, 6].map(ok)).toEqual([
      true,
      true,
      false,
      false,
      true,
      false,
      true,
    ]);
  });

  it("base64ToInt16 decodes little-endian signed samples", () => {
    // bytes: 01 00 | ff ff | 00 80 -> 1, -1, -32768
    const b64 = btoa(String.fromCharCode(1, 0, 255, 255, 0, 128));
    expect(Array.from(base64ToInt16(b64))).toEqual([1, -1, -32768]);
    expect(base64ToInt16(btoa(String.fromCharCode(1, 0, 9))).length).toBe(1);
  });

  it("level math", () => {
    expect(outputLevelFromRms(0)).toBe(0);
    expect(outputLevelFromRms(0.1)).toBeCloseTo(1 - Math.exp(-4));
    expect(smoothLevel(0, 1)).toBe(0.5);
    expect(smoothLevel(0.9, 10)).toBe(1);
    const loud = new Int16Array(800).fill(16384).buffer;
    expect(pcmFrameLevel(loud)).toBeCloseTo(0.5 * 14);
  });
});
