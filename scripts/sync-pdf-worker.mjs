#!/usr/bin/env node
/**
 * Keep the self-hosted pdf.js worker in sync with the installed
 * pdfjs-dist version: pdf-thumbnail.ts loads /pdf.worker.min.mjs at
 * runtime, and a version mismatch silently breaks PDF thumbnails.
 * Runs on every install via the `prepare` script.
 */
import { copyFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const worker = join(
  dirname(require.resolve("pdfjs-dist/package.json")),
  "build",
  "pdf.worker.min.mjs",
);
const dest = join(root, "clients", "web", "public", "pdf.worker.min.mjs");

if (!existsSync(worker)) {
  console.error(`[sync-pdf-worker] worker not found at ${worker}`);
  process.exit(1);
}
copyFileSync(worker, dest);
console.log(`[sync-pdf-worker] synced ${dest}`);
