import { describe, expect, it } from "vitest";
import {
  FLUSH_CATCH_UP_MS,
  nextRevealLength,
  STREAM_CATCH_UP_MS,
} from "./use-smooth-text";

const long = "word ".repeat(200);

describe("nextRevealLength", () => {
  it("returns the target length when caught up", () => {
    expect(nextRevealLength(5, "hello", 16)).toBe(5);
  });

  it("snaps down when the target shrank", () => {
    expect(nextRevealLength(50, "short", 16)).toBe(5);
  });

  it("always advances by at least one character", () => {
    expect(nextRevealLength(0, "abcdefghij", 1)).toBeGreaterThanOrEqual(1);
  });

  it("never goes backwards and never overshoots", () => {
    let shown = 0;
    for (let i = 0; i < 200; i++) {
      const next = nextRevealLength(shown, long, 16);
      expect(next).toBeGreaterThanOrEqual(shown);
      expect(next).toBeLessThanOrEqual(long.length);
      shown = next;
    }
  });

  it("drains a backlog within about the catch-up window", () => {
    const text = "x".repeat(400);
    let shown = 0;
    let elapsed = 0;
    while (shown < text.length && elapsed < 2000) {
      shown = nextRevealLength(shown, text, 16);
      elapsed += 16;
    }
    expect(shown).toBe(text.length);
    expect(elapsed).toBeLessThanOrEqual(STREAM_CATCH_UP_MS * 3);
  });

  it("flushes faster with the shorter flush window", () => {
    const text = "x".repeat(400);
    const run = (catchUp: number) => {
      let shown = 0;
      let frames = 0;
      while (shown < text.length) {
        shown = nextRevealLength(shown, text, 16, catchUp);
        frames++;
      }
      return frames;
    };
    expect(run(FLUSH_CATCH_UP_MS)).toBeLessThan(run(STREAM_CATCH_UP_MS));
  });

  it("jumps to the end after a long frame gap", () => {
    expect(nextRevealLength(0, long, 1000)).toBe(long.length);
  });

  it("prefers ending on a word boundary", () => {
    const text = "hello wonderful world and more";
    const next = nextRevealLength(0, text, 16);
    expect(next === text.length || /\s/.test(text[next])).toBe(true);
  });

  it("does not split a surrogate pair", () => {
    const text = "😀".repeat(50);
    for (let shown = 0; shown < text.length; ) {
      shown = nextRevealLength(shown, text, 16);
      if (shown < text.length) {
        const c = text.charCodeAt(shown - 1);
        expect(c >= 0xd800 && c <= 0xdbff).toBe(false);
      }
    }
  });
});
