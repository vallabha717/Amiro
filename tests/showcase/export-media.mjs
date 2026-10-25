#!/usr/bin/env node
// Turns a showcase run's recordings into the media the README and the
// Mintlify docs embed:
//
//   docs/assets/showcase/<scene>.mp4   H.264, long agent turns sped up (docs <video>)
//   docs/assets/showcase/<scene>.gif   sped up, palette-optimised (README)
//   docs/assets/showcase/<scene>.jpg   poster frame
//
//   node tests/showcase/export-media.mjs [tests/recordings/showcase-<stamp>]
//
// With no argument it uses the newest tests/recordings/showcase-* run. Only
// passed attempts are exported; re-record a failed scene with --project.
// Needs ffmpeg on PATH (or FFMPEG=/path/to/ffmpeg).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const OUT = path.join(ROOT, "docs/assets/showcase");
const FFMPEG = process.env.FFMPEG || "ffmpeg";
// Every GIF is committed to the repo, so keep each one small.
const GIF_MAX_BYTES = 4.5e6;

const recordings = path.join(ROOT, "tests/recordings");
const runDir =
  process.argv[2] ??
  fs
    .readdirSync(recordings)
    .filter((d) => d.startsWith("showcase-"))
    .sort()
    .map((d) => path.join(recordings, d))
    .pop();
if (!runDir || !fs.existsSync(path.join(runDir, "results.json"))) {
  console.error("export-media: no showcase run with results.json found");
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });

const ffmpeg = (args) => {
  const r = spawnSync(FFMPEG, ["-y", "-loglevel", "error", ...args], { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${args.join(" ")}`);
};
const probeSeconds = (file) =>
  Number(
    spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], {
      encoding: "utf8",
    }).stdout.trim(),
  ) || 0;

/** Every test result in the JSON report, with its annotations and video. */
function* results(report) {
  const walk = function* (suite) {
    for (const spec of suite.specs ?? [])
      for (const t of spec.tests ?? [])
        for (const r of t.results ?? [])
          yield { title: spec.title, annotations: [...(t.annotations ?? []), ...(r.annotations ?? [])], r };
    for (const s of suite.suites ?? []) yield* walk(s);
  };
  for (const s of report.suites ?? []) yield* walk(s);
}

const report = JSON.parse(fs.readFileSync(path.join(runDir, "results.json"), "utf8"));
const done = [];
for (const { title, annotations, r } of results(report)) {
  const slug = annotations.find((a) => a.type === "showcase")?.description;
  const video = r.attachments?.find((a) => a.name === "video" && a.path)?.path;
  if (!slug || !video || !fs.existsSync(video)) continue;
  // A failed attempt (say, a provider 429) never replaces a good video.
  if (r.status !== "passed") {
    console.warn(`! ${slug}: attempt ${r.status}, skipped`);
    continue;
  }
  const pip = annotations.find((a) => a.type === "showcase-pip")?.description;

  // 1. A clean master at real speed, with the phone picture-in-picture if any.
  const master = path.join(runDir, `${slug}.master.mp4`);
  const inputs = ["-i", video];
  let graph = "[0:v]scale=1440:-2[b0]";
  let last = "b0";
  if (pip) {
    const { path: phone, offsetMs } = JSON.parse(pip);
    if (fs.existsSync(phone)) {
      inputs.push("-itsoffset", String(offsetMs / 1000), "-i", phone);
      graph +=
        ";[1:v]scale=-2:640,pad=iw+8:ih+8:4:4:color=0x1f2937[ph]" +
        ";[b0][ph]overlay=W-w-40:H-h-90:eof_action=repeat[b1]";
      last = "b1";
    }
  }
  graph += `;[${last}]fps=25[v]`;
  ffmpeg([...inputs, "-filter_complex", graph, "-map", "[v]", "-an", "-c:v", "libx264", "-preset", "slow", "-crf", "18", master]);

  // 2. Docs video: 1280 wide, small, streams from the first byte. Waiting on a
  //    real model is real time, so long scenes play a little faster.
  const realSecs = probeSeconds(master);
  const docSpeed = realSecs > 150 ? 2 : realSecs > 75 ? 1.5 : 1;
  const mp4 = path.join(OUT, `${slug}.mp4`);
  ffmpeg([
    "-i", master, "-vf", `setpts=PTS/${docSpeed},scale=1280:-2`, "-c:v", "libx264", "-preset", "slow", "-crf", "30",
    "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", mp4,
  ]);

  // 3. Poster: a frame near the end, where the result is on screen.
  const secs = realSecs;
  ffmpeg(["-ss", String(Math.max(0, secs - 2)), "-i", master, "-frames:v", "1", "-vf", "scale=1280:-2", "-q:v", "4", path.join(OUT, `${slug}.jpg`)]);

  // 4. README GIF: sped up so a long agent turn fits; shrink until it is under the limit.
  const gif = path.join(OUT, `${slug}.gif`);
  const speed = secs > 240 ? 6 : secs > 120 ? 4 : secs > 60 ? 3 : 2;
  for (const [width, fps] of [[880, 8], [800, 7], [720, 6], [640, 5], [560, 5]]) {
    const palette = path.join(runDir, `${slug}.palette.png`);
    const f = `setpts=PTS/${speed},fps=${fps},scale=${width}:-1:flags=lanczos`;
    ffmpeg(["-i", master, "-vf", `${f},palettegen=max_colors=128:stats_mode=diff`, palette]);
    ffmpeg(["-i", master, "-i", palette, "-lavfi", `${f}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`, "-loop", "0", gif]);
    if (fs.statSync(gif).size <= GIF_MAX_BYTES) break;
  }
  const mb = (f) => (fs.statSync(f).size / 1e6).toFixed(1);
  done.push(`${slug}: ${secs.toFixed(0)}s · mp4 ${mb(mp4)} MB (${docSpeed}x) · gif ${mb(gif)} MB (${speed}x) — ${title}`);
}
console.log(done.length ? done.join("\n") : "export-media: no showcase videos in this run");
