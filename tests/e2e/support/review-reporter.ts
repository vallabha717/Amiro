/**
 * Turns a Playwright run into something another agent (or a person) can review:
 *
 *   recordings/<stamp>/
 *     full-run.mp4            every test back to back, a title card before each,
 *                             with MP4 chapters per test
 *     suites/<project>.mp4    the same, one file per journey
 *     videos/NN-<project>--<test>.webm   raw per-test recordings
 *     REVIEW.md / review.json what each test did, step by step, with the
 *                             timestamp of every step in full-run.mp4, plus
 *                             console errors, failed API calls and UX notes
 *
 * Stitching needs ffmpeg/ffprobe on PATH; without them the per-test videos
 * and the report are still written.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { FullResult, Reporter, TestCase, TestResult } from "@playwright/test/reporter";

interface Entry {
  index: number;
  project: string;
  title: string;
  file: string;
  status: string;
  durationMs: number;
  error?: string;
  skipReason?: string;
  rawVideo?: string;
  video?: string;
  videoSeconds?: number;
  fullRunOffsetS?: number;
  suiteOffsetS?: number;
  steps: { title: string; atMs: number; durationMs?: number; status?: string }[];
  diagnostics?: {
    consoleErrors: { atMs: number; text: string }[];
    pageErrors: { atMs: number; message: string }[];
    failedRequests: { atMs: number; status: number; method: string; url: string }[];
    notes: { atMs: number; kind: string; text: string }[];
  };
  screenshots: string[];
}

const TITLE_CARD_S = 2.5;

function has(bin: string) {
  try {
    execFileSync(bin, ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
}

function fmt(s: number) {
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${String(m).padStart(2, "0")}:${r.toFixed(1).padStart(4, "0")}`;
}

function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if ((line + " " + word).trim().length > width && line) {
      out.push(line);
      line = word;
    } else line = `${line} ${word}`.trim();
  }
  if (line) out.push(line);
  return out;
}

function findFont(): string | undefined {
  for (const f of [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/Library/Fonts/Arial Bold.ttf",
  ])
    if (fs.existsSync(f)) return f;
  try {
    const f = execFileSync("fc-match", ["-f", "%{file}", "sans:bold"], { encoding: "utf8" }).trim();
    if (f && fs.existsSync(f)) return f;
  } catch {}
  return undefined;
}

export default class ReviewReporter implements Reporter {
  private entries: Entry[] = [];
  private runDir: string;
  private stitch: boolean;

  constructor(opts: { runDir: string; stitch?: boolean }) {
    this.runDir = opts.runDir;
    this.stitch = opts.stitch !== false;
  }

  printsToStdio() {
    return false;
  }

  onTestEnd(test: TestCase, result: TestResult) {
    const read = (name: string) => {
      const a = result.attachments.find((x) => x.name === name);
      if (!a) return undefined;
      try {
        return JSON.parse(a.body ? a.body.toString() : fs.readFileSync(a.path!, "utf8"));
      } catch {
        return undefined;
      }
    };
    const project = test.parent.project()?.name ?? "default";
    this.entries.push({
      index: this.entries.length + 1,
      project,
      title: test.titlePath().slice(3).join(" › ") || test.title,
      file: path.basename(test.location.file),
      status: result.status,
      durationMs: result.duration,
      error: result.error?.message?.replace(/\u001b\[[0-9;]*m/g, "").slice(0, 2000),
      skipReason: test.annotations.find((a) => a.type === "skip")?.description,
      rawVideo: result.attachments.find((a) => a.name === "video")?.path,
      steps: read("steps.json") ?? [],
      diagnostics: read("diagnostics.json"),
      screenshots: result.attachments.filter((a) => a.contentType === "image/png" && a.path).map((a) => a.path!),
    });
  }

  async onEnd(result: FullResult) {
    if (!this.entries.length) {
      // e.g. `--list`: leave no empty recording folder behind.
      if (fs.existsSync(this.runDir) && !fs.readdirSync(this.runDir).some((f) => f !== "test-results" && f !== "html")) {
        fs.rmSync(this.runDir, { recursive: true, force: true });
      }
      return;
    }
    const videosDir = path.join(this.runDir, "videos");
    fs.mkdirSync(videosDir, { recursive: true });
    const canProbe = has("ffprobe");
    for (const e of this.entries) {
      if (!e.rawVideo || !fs.existsSync(e.rawVideo)) continue;
      const name = `${String(e.index).padStart(2, "0")}-${e.project}--${slug(e.title)}.webm`;
      e.video = path.join(videosDir, name);
      fs.copyFileSync(e.rawVideo, e.video);
      if (canProbe) {
        try {
          e.videoSeconds = Number(
            execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", e.video], {
              encoding: "utf8",
            }).trim(),
          );
        } catch {}
      }
    }

    let stitched: { full?: string; suites: Record<string, string> } = { suites: {} };
    if (this.stitch && has("ffmpeg") && canProbe) {
      try {
        stitched = this.stitchAll();
      } catch (err) {
        console.error("[review] stitching failed:", (err as Error).message);
      }
    }
    this.writeReport(result, stitched);
    const rel = path.relative(process.cwd(), this.runDir);
    console.log(`\n[review] report: ${rel}/REVIEW.md`);
    if (stitched.full) console.log(`[review] full video: ${path.relative(process.cwd(), stitched.full)}`);
  }

  /** Re-encode each test (title card + recording) to a common format, then concat. */
  private stitchAll() {
    const work = path.join(this.runDir, ".stitch");
    fs.mkdirSync(work, { recursive: true });
    const font = findFont();
    const withVideo = this.entries.filter((e) => e.video && e.videoSeconds);
    if (!withVideo.length) return { suites: {} };
    const size = execFileSync(
      "ffprobe",
      ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", withVideo[0].video!],
      { encoding: "utf8" },
    ).trim();
    const [w, h] = size.split("x").map(Number);

    const segments: { entry: Entry; file: string; seconds: number }[] = [];
    for (const e of withVideo) {
      const out = path.join(work, `${String(e.index).padStart(2, "0")}.mp4`);
      const clean = (t: string) => t.replace(/›/g, ">").replace(/[':\\%,]/g, " ").replace(/\s+/g, " ").trim();
      const lines = wrap(clean(e.title), 60).slice(0, 3);
      const status = e.status.toUpperCase();
      const color = e.status === "passed" ? "0x22c55e" : e.status === "skipped" ? "0xeab308" : "0xef4444";
      const fs1 = Math.round(h / 30);
      const text = (t: string, y: string, size: number, c = "white") =>
        `drawtext=fontfile=${font}:text='${t}':fontcolor=${c}:fontsize=${size}:x=(w-text_w)/2:y=${y}`;
      const draws = font
        ? [
            text(`#${e.index}  ${e.project.toUpperCase()}`, `(h/2)-${Math.round(h / 6)}`, Math.round(h / 40), "0x94a3b8"),
            ...lines.map((l, i) => text(l, `(h/2)-${Math.round(h / 10)}+${i * Math.round(fs1 * 1.4)}`, fs1)),
            text(status, `(h/2)+${Math.round(h / 8)}`, Math.round(h / 20), color),
          ].join(",")
        : "null";
      const filters = [
        `color=c=0x0f172a:s=${w}x${h}:d=${TITLE_CARD_S}:r=25[card0]`,
        `[card0]${draws}[card]`,
        `[0:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,fps=25,setsar=1[vid]`,
        "[card][vid]concat=n=2:v=1:a=0,format=yuv420p[out]",
      ].join(";");
      execFileSync(
        "ffmpeg",
        ["-y", "-v", "error", "-i", e.video!, "-filter_complex", filters, "-map", "[out]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", out],
        { stdio: "inherit" },
      );
      segments.push({ entry: e, file: out, seconds: TITLE_CARD_S + (e.videoSeconds ?? 0) });
    }

    const concat = (segs: typeof segments, out: string, offsetKey: "fullRunOffsetS" | "suiteOffsetS") => {
      const list = path.join(work, `${path.basename(out)}.txt`);
      fs.writeFileSync(list, segs.map((s) => `file '${s.file}'`).join("\n"));
      let t = 0;
      const chapters = [";FFMETADATA1"];
      for (const s of segs) {
        s.entry[offsetKey] = t;
        chapters.push(
          "[CHAPTER]",
          "TIMEBASE=1/1000",
          `START=${Math.round(t * 1000)}`,
          `END=${Math.round((t + s.seconds) * 1000)}`,
          `title=${`${s.entry.index}. [${s.entry.project}] ${s.entry.title} (${s.entry.status})`.replace(/[=;#\\\n]/g, " ")}`,
        );
        t += s.seconds;
      }
      const meta = path.join(work, `${path.basename(out)}.meta`);
      fs.writeFileSync(meta, chapters.join("\n"));
      execFileSync(
        "ffmpeg",
        ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", list, "-i", meta, "-map_metadata", "1", "-map_chapters", "1", "-c", "copy", out],
        { stdio: "inherit" },
      );
    };

    const suites: Record<string, string> = {};
    const suitesDir = path.join(this.runDir, "suites");
    fs.mkdirSync(suitesDir, { recursive: true });
    for (const project of [...new Set(segments.map((s) => s.entry.project))]) {
      const out = path.join(suitesDir, `${project}.mp4`);
      concat(segments.filter((s) => s.entry.project === project), out, "suiteOffsetS");
      suites[project] = out;
    }
    const full = path.join(this.runDir, "full-run.mp4");
    concat(segments, full, "fullRunOffsetS");
    fs.rmSync(work, { recursive: true, force: true });
    return { full, suites };
  }

  private writeReport(result: FullResult, stitched: { full?: string; suites: Record<string, string> }) {
    const rel = (p?: string) => (p ? path.relative(this.runDir, p) : "");
    const counts = this.entries.reduce<Record<string, number>>((m, e) => ((m[e.status] = (m[e.status] ?? 0) + 1), m), {});
    const L: string[] = [];
    L.push("# Amiro E2E review", "");
    L.push(`Run status: **${result.status}** · ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(" · ")}`, "");
    if (stitched.full) L.push(`Full video: [\`${rel(stitched.full)}\`](${rel(stitched.full)}) (chapters per test)`, "");
    const suiteLinks = Object.entries(stitched.suites).map(([k, v]) => `[\`${k}\`](${rel(v)})`);
    if (suiteLinks.length) L.push(`Per-journey videos: ${suiteLinks.join(" · ")}`, "");
    const findings: string[] = [];
    for (const e of this.entries) {
      const base = (e.fullRunOffsetS ?? 0) + (e.fullRunOffsetS !== undefined ? TITLE_CARD_S : 0);
      for (const n of e.diagnostics?.notes ?? [])
        if (n.kind !== "info") findings.push(`- **${n.kind}** @${fmt(base + n.atMs / 1000)} [${e.project}] ${n.text}`);
      if (e.status === "failed" || e.status === "timedOut")
        findings.push(`- **failed** @${fmt(base)} [${e.project}] ${e.title}: ${(e.error ?? "").split("\n")[0].slice(0, 200)}`);
    }
    if (findings.length) L.push("## Findings at a glance", "", ...findings, "");
    L.push(
      "## How to review",
      "",
      "You are reviewing a recorded end-to-end run of Amiro (a self-hosted AI agent app). For each test below:",
      "watch the video at the given timestamp, read the steps, and report:",
      "",
      "1. **Bugs**: anything broken, wrong, or that errored (use the console/API errors listed).",
      "2. **UX problems**: confusing copy, missing feedback or loading states, dead ends, unlabeled controls, slow steps, layout issues.",
      "3. **Fix**: for each finding, the concrete change (which page/component, what to do).",
      "",
      "Steps are captioned at the bottom of the video. `@mm:ss` is the position in `full-run.mp4`.",
      "",
      "## Summary",
      "",
      "| # | Journey | Test | Status | Time | Video |",
      "|---|---|---|---|---|---|",
    );
    for (const e of this.entries) {
      const at = e.fullRunOffsetS !== undefined ? ` @${fmt(e.fullRunOffsetS)}` : "";
      L.push(
        `| ${e.index} | ${e.project} | ${e.title.replace(/\|/g, "/")} | ${e.status} | ${(e.durationMs / 1000).toFixed(1)}s | ${e.video ? `[webm](${rel(e.video)})${at}` : "-"} |`,
      );
    }
    for (const e of this.entries) {
      L.push("", `## ${e.index}. [${e.project}] ${e.title} — ${e.status.toUpperCase()}`, "");
      if (e.skipReason) L.push(`Skipped: ${e.skipReason}`, "");
      if (e.video) L.push(`Video: \`${rel(e.video)}\`${e.fullRunOffsetS !== undefined ? ` · in full-run.mp4 from ${fmt(e.fullRunOffsetS)}` : ""}`, "");
      const base = (e.fullRunOffsetS ?? 0) + (e.fullRunOffsetS !== undefined ? TITLE_CARD_S : 0);
      if (e.steps.length) {
        L.push("Steps:", "");
        for (const s of e.steps)
          L.push(`- @${fmt(base + s.atMs / 1000)} ${s.status === "failed" ? "❌" : "✅"} ${s.title}${s.durationMs ? ` (${(s.durationMs / 1000).toFixed(1)}s)` : ""}`);
        L.push("");
      }
      if (e.error) L.push("Error:", "", "```", e.error, "```", "");
      const d = e.diagnostics;
      if (d?.notes?.length) {
        L.push("Observations recorded by the test:", "");
        for (const n of d.notes) L.push(`- @${fmt(base + n.atMs / 1000)} [${n.kind}] ${n.text}`);
        L.push("");
      }
      if (d?.pageErrors?.length) {
        L.push("Uncaught page errors:", "");
        for (const x of d.pageErrors.slice(0, 15)) L.push(`- @${fmt(base + x.atMs / 1000)} ${x.message}`);
        L.push("");
      }
      if (d?.consoleErrors?.length) {
        L.push(`Console errors (${d.consoleErrors.length}):`, "");
        for (const x of d.consoleErrors.slice(0, 15)) L.push(`- @${fmt(base + x.atMs / 1000)} ${x.text.replace(/\n/g, " ")}`);
        L.push("");
      }
      if (d?.failedRequests?.length) {
        L.push(`Failed API calls (${d.failedRequests.length}):`, "");
        for (const x of d.failedRequests.slice(0, 20)) L.push(`- @${fmt(base + x.atMs / 1000)} ${x.status} ${x.method} ${x.url.replace(/^https?:\/\/[^/]+/, "")}`);
        L.push("");
      }
    }
    fs.writeFileSync(path.join(this.runDir, "REVIEW.md"), L.join("\n"));
    fs.writeFileSync(
      path.join(this.runDir, "review.json"),
      JSON.stringify({ status: result.status, fullVideo: rel(stitched.full), suites: stitched.suites, tests: this.entries }, null, 2),
    );
  }
}
