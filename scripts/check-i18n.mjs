#!/usr/bin/env node
// Check that every locale in clients/web/messages/ has exactly the keys and {placeholders}
// of clients/web/messages/en.json. Exits 1 on any difference.
//   node scripts/check-i18n.mjs        (also: pnpm check:i18n)
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dir = join(import.meta.dirname, "..", "clients", "web", "messages");
const flat = (obj, prefix = "") =>
  Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === "object" ? flat(v, `${prefix}${k}.`) : [[`${prefix}${k}`, String(v)]],
  );
// Variable names only: ICU plural branches may differ between languages.
const vars = (s) =>
  [...new Set([...s.matchAll(/(?<!\b(?:zero|one|two|few|many|other|=\d+)\s?)\{(\w+)\s*[},]/g)].map((m) => m[1]))]
    .sort()
    .join(",");

const en = new Map(flat(JSON.parse(readFileSync(join(dir, "en.json"), "utf8"))));
let failed = false;
for (const file of readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "en.json")) {
  const other = new Map(flat(JSON.parse(readFileSync(join(dir, file), "utf8"))));
  const missing = [...en.keys()].filter((k) => !other.has(k));
  const extra = [...other.keys()].filter((k) => !en.has(k));
  const badVars = [...en.keys()].filter((k) => other.has(k) && vars(en.get(k)) !== vars(other.get(k)));
  for (const [label, list] of [["missing", missing], ["extra", extra], ["placeholder mismatch", badVars]]) {
    if (list.length) {
      failed = true;
      console.error(`${file}: ${label} (${list.length}): ${list.slice(0, 20).join(", ")}`);
    }
  }
  if (!missing.length && !extra.length && !badVars.length) console.log(`${file}: ${other.size} keys match en.json`);
}
process.exit(failed ? 1 : 0);
