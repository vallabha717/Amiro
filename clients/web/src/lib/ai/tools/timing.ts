/**
 * Utilities for parsing and formatting Jcode runtime tool timing headers.
 *
 * Jcode tool outputs often begin with a metadata header like:
 *   [tool timing: start=2026-10-18T07:46:43.641Z finish=2026-10-18T07:46:50.635Z duration=7.0s]
 *
 * Stripping this prefix leaves the clean tool output for the viewer while
 * extracting the duration string to display as a sleek pill badge.
 */

export interface ParsedToolTiming {
  cleanText: string;
  duration?: string;
  timingMeta?: string;
}

const TIMING_HEADER_REGEX = /^\[tool timing:\s*([^\]]+)\]\s*/;

export function parseToolTiming(raw: unknown): ParsedToolTiming {
  if (typeof raw !== "string") {
    return { cleanText: typeof raw === "object" && raw !== null ? JSON.stringify(raw, null, 2) : "" };
  }
  const match = raw.match(TIMING_HEADER_REGEX);
  if (!match) {
    return { cleanText: raw };
  }
  const timingMeta = match[1];
  const durMatch = timingMeta.match(/duration=([^\s,\]]+)/);
  const duration = durMatch ? durMatch[1] : undefined;
  const cleanText = raw.slice(match[0].length);
  return { cleanText, duration, timingMeta };
}

export function stripTimingPrefix(raw: string): string {
  return raw.replace(TIMING_HEADER_REGEX, "");
}
