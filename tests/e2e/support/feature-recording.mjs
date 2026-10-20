#!/usr/bin/env node
// Hand the owner the recording of ONLY what was just implemented.
//
// Picks the tests matching --grep from an E2E run (default: the latest run in
// tests/recordings/), stitches their videos into one feature-<slug>.mp4, writes
// FEATURE.md (each test's status, video and step timestamps inside that mp4)
// and prints absolute paths to paste into the final answer.
//
//   pnpm --dir tests e2e:feature --grep "web search|visualize"
//   pnpm --dir tests e2e:feature --grep "connectors" --run tests/recordings/<stamp>
//   --include-setup   also keep the onboarding/provider prerequisite tests
//
// The prerequisite journeys always run first (they set up a fresh instance);
// they are left out of the feature video unless --include-setup is given.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const TESTS_DIR = path.resolve(import.meta.dirname, "../..");
const SETUP = new Set(["onboarding", "provider"]);

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const grep = opt("--grep");
if (!grep) {
  console.error('usage: e2e:feature --grep "<regex matching your test titles or journey>" [--run <dir>] [--include-setup]');
  process.exit(2);
}
const includeSetup = args.includes("--include-setup");

function latestRun() {
  const root = path.join(TESTS_DIR, "recordings");
  const runs = fs
    .readdirSync(root)
    .filter((d) => fs.existsSync(path.join(root, d, "review.json")))
    .sort();
  if (!runs.length) throw new Error(`no finished run with review.json under ${root}`);
  return path.join(root, runs[runs.length - 1]);
}

const runDir = path.resolve(opt("--run") ?? latestRun());
const review = JSON.parse(fs.readFileSync(path.join(runDir, "review.json"), "utf8"));
const re = new RegExp(grep, "i");
const picked = review.tests.filter(
  (t) => (includeSetup || !SETUP.has(t.project)) && (re.test(t.title) || re.test(t.project)),
);
if (!picked.length) {
  console.error(`no tests in ${runDir} match /${grep}/i (setup journeys excluded${includeSetup ? " — none" : ""})`);
  process.exit(1);
}

const slug = grep.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "feature";
const out = path.join(runDir, `feature-${slug}.mp4`);
const withVideo = picked.filter((t) => t.video && fs.existsSync(t.video));

let stitched = false;
if (withVideo.length) {
  try {
    const list = path.join(runDir, `.feature-${slug}.txt`);
    fs.writeFileSync(list, withVideo.map((t) => `file '${t.video}'`).join("\n"));
    execFileSync(
      "ffmpeg",
      ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", list, "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-pix_fmt", "yuv420p", out],
      { stdio: "inherit" },
    );
    fs.rmSync(list, { force: true });
    stitched = true;
  } catch (e) {
    console.error(`could not stitch (is ffmpeg installed?): ${e.message}`);
  }
}

const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${(s % 60).toFixed(1).padStart(4, "0")}`;
const lines = [`# Feature recording: /${grep}/`, "", `Run: \`${runDir}\``, ""];
if (stitched) lines.push(`Video of only these tests: \`${out}\``, "");
let offset = 0;
for (const t of picked) {
  lines.push(`## [${t.project}] ${t.title} — ${t.status.toUpperCase()}`, "");
  if (t.video) lines.push(`Own video: \`${t.video}\`${stitched && withVideo.includes(t) ? ` · in feature video from ${fmt(offset)}` : ""}`, "");
  for (const s of t.steps ?? []) lines.push(`- @${fmt(offset + s.atMs / 1000)} ${s.status === "failed" ? "❌" : "✅"} ${s.title}`);
  const notes = (t.diagnostics?.notes ?? []).filter((n) => n.kind !== "info");
  if (notes.length) lines.push("", ...notes.map((n) => `- **${n.kind}**: ${n.text}`));
  if (t.error) lines.push("", "```", t.error.split("\n").slice(0, 8).join("\n"), "```");
  lines.push("");
  if (withVideo.includes(t)) offset += t.videoSeconds ?? 0;
}
const md = path.join(runDir, `FEATURE-${slug}.md`);
fs.writeFileSync(md, lines.join("\n"));

const counts = picked.reduce((m, t) => ((m[t.status] = (m[t.status] ?? 0) + 1), m), {});
console.log(`\nFeature recording (${picked.length} test(s): ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ")})`);
if (stitched) console.log(`  video:   ${out}`);
console.log(`  report:  ${md}`);
for (const t of picked) console.log(`  ${t.status.padEnd(7)} [${t.project}] ${t.title}\n           ${t.video ?? "(no video)"}`);
