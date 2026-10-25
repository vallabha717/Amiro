#!/usr/bin/env node
// Writes latest.json, the feed the desktop app's updater reads
// (plugins.updater.endpoints in clients/desktop/tauri.conf.json):
//
//   node scripts/updater-manifest.mjs <dir> <tag> [owner/repo] [notes-file]
//
// <dir> holds the release's signed update bundles and their .sig files, as
// .github/workflows/desktop.yml names them:
//
//   amiro-desktop-macos-<arch>.app.tar.gz(.sig)     macOS (app bundle)
//   amiro-desktop-windows-<arch>-setup.exe(.sig)    Windows (NSIS installer)
//   amiro-desktop-linux-<arch>.AppImage(.sig)       Linux (AppImage)
//
// Platforms without a .sig are left out (that build failed or was skipped).
// Exits 2 when no platform is signed, so a release never ships an empty feed.
import fs from "node:fs";
import path from "node:path";

const [dir, tag, repo = "vallabha717/Amiro", notesFile] = process.argv.slice(2);
if (!dir || !tag || !/^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(tag)) {
  console.error("usage: updater-manifest.mjs <dir> <vX.Y.Z> [owner/repo] [notes-file]");
  process.exit(2);
}

// Tauri platform keys -> the file each one installs. The "-<installer>"
// keys let the updater pick the right file when several are offered.
const targets = [];
for (const arch of ["x86_64", "aarch64"]) {
  targets.push(
    { keys: [`darwin-${arch}`, `darwin-${arch}-app`], file: `amiro-desktop-macos-${arch}.app.tar.gz` },
    { keys: [`windows-${arch}`, `windows-${arch}-nsis`], file: `amiro-desktop-windows-${arch}-setup.exe` },
    { keys: [`linux-${arch}`, `linux-${arch}-appimage`], file: `amiro-desktop-linux-${arch}.AppImage` },
  );
}

const platforms = {};
for (const { keys, file } of targets) {
  const sig = path.join(dir, `${file}.sig`);
  if (!fs.existsSync(sig) || !fs.existsSync(path.join(dir, file))) continue;
  const entry = {
    signature: fs.readFileSync(sig, "utf8").trim(),
    url: `https://github.com/${repo}/releases/download/${tag}/${file}`,
  };
  for (const key of keys) platforms[key] = entry;
}

if (Object.keys(platforms).length === 0) {
  console.error(`updater-manifest: no signed update bundles in ${dir}`);
  process.exit(2);
}

const notes = notesFile && fs.existsSync(notesFile)
  ? fs.readFileSync(notesFile, "utf8").trim()
  : `See https://github.com/${repo}/releases/tag/${tag}`;

const manifest = {
  version: tag.replace(/^v/, ""),
  notes,
  pub_date: new Date().toISOString(),
  platforms,
};
const out = path.join(dir, "latest.json");
fs.writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(
  `wrote ${out}: ${tag} for ${[...new Set(Object.keys(platforms).map((k) => k.split("-").slice(0, 2).join("-")))].join(", ")}`,
);
