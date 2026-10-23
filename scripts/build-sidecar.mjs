#!/usr/bin/env node
// Stage the desktop app's sidecars for Tauri, on macOS, Linux and Windows.
//
//   node scripts/build-sidecar.mjs [--build] [--target <rust-triple>]
//
// Tauri's bundle.externalBin needs `clients/desktop/binaries/<name>-<triple>[.exe]`
// for both sidecars: `backend` (amiro-backend) and `runtime` (amiro-runtime).
// With --build, missing release binaries are compiled first. Respects
// AMIRO_NATIVE_BACKEND_BIN / AMIRO_NATIVE_RUNTIME_BIN to use prebuilt ones.
// (The old Node-adapter launcher lives on in clients/desktop/build-sidecar.sh with
// AMIRO_SIDECAR_MODE=adapter, for local development only.)
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const build = args.includes("--build");
const targetFlag = args.indexOf("--target");
const target =
  (targetFlag >= 0 && args[targetFlag + 1]) ||
  process.env.TAURI_ENV_TARGET_TRIPLE ||
  execFileSync("rustc", ["-Vv"], { encoding: "utf8" })
    .split("\n")
    .find((line) => line.startsWith("host:"))
    ?.slice(5)
    .trim();
if (!target) {
  console.error("error: could not determine the Rust target triple (is rustc on PATH?)");
  process.exit(1);
}
const exe = target.includes("windows") ? ".exe" : "";
const hostTarget = execFileSync("rustc", ["-Vv"], { encoding: "utf8" }).includes(`host: ${target}`);

const sidecars = [
  {
    slot: "backend",
    env: "AMIRO_NATIVE_BACKEND_BIN",
    manifest: "backend/Cargo.toml",
    bin: "amiro-backend",
    crateDir: "backend",
  },
  {
    slot: "runtime",
    env: "AMIRO_NATIVE_RUNTIME_BIN",
    manifest: "runtime/Cargo.toml",
    bin: "amiro-runtime",
    crateDir: "runtime",
    // Same features as scripts/build-native.sh (the shipped runtime).
    extra: ["--no-default-features"],
  },
];

const outDir = join(root, "clients/desktop", "binaries");
mkdirSync(outDir, { recursive: true });

for (const s of sidecars) {
  const profileDir = hostTarget
    ? join(root, s.crateDir, "target", "release")
    : join(root, s.crateDir, "target", target, "release");
  let source = process.env[s.env] || join(profileDir, s.bin + exe);
  if (!existsSync(source) && build) {
    console.log(`building ${s.bin} (${target})…`);
    const cargoArgs = ["build", "--manifest-path", s.manifest, "--release", "--bin", s.bin];
    if (s.extra) cargoArgs.push(...s.extra);
    if (!hostTarget) cargoArgs.push("--target", target);
    execFileSync("cargo", cargoArgs, { cwd: root, stdio: "inherit" });
  }
  if (!existsSync(source)) {
    const debug = join(root, s.crateDir, "target", "debug", s.bin + exe);
    if (hostTarget && existsSync(debug)) source = debug;
  }
  if (!existsSync(source)) {
    console.error(
      `error: ${s.bin} not found at ${source}\n` +
        `       build it with: cargo build --manifest-path ${s.manifest} --release --bin ${s.bin}\n` +
        "       or rerun with --build",
    );
    process.exit(1);
  }
  const dest = join(outDir, `${s.slot}-${target}${exe}`);
  copyFileSync(source, dest);
  if (!exe) chmodSync(dest, 0o755);
  console.log(`staged ${s.slot} sidecar -> ${dest}`);
}
