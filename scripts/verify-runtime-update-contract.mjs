import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(path.join(root, file), "utf8");
const manifest = JSON.parse(read("docs/runtime-customizations.json"));
assert.equal(
  manifest.schemaVersion,
  1,
  "Supported customization inventory schema",
);
assert.equal(manifest.upstreamRepository, "https://github.com/1jehuang/jcode");
assert.match(manifest.recordedUpstreamCommit, /^[0-9a-f]{40}$/);
assert(
  read("runtime/PROVENANCE.md").includes(manifest.recordedUpstreamCommit),
  "Inventory upstream SHA matches provenance",
);
assert(
  Array.isArray(manifest.areas) && manifest.areas.length >= 6,
  "Required preservation areas exist",
);
const ids = new Set();
let sentinels = 0;
for (const area of manifest.areas) {
  assert(
    typeof area.id === "string" && !ids.has(area.id),
    "Unique preservation area ID",
  );
  ids.add(area.id);
  assert(typeof area.requirement === "string" && area.requirement.length > 20);
  assert(
    Array.isArray(area.checks) && area.checks.length > 0,
    `${area.id} has regression checks`,
  );
  assert(Array.isArray(area.sentinels) && area.sentinels.length > 0);
  for (const sentinel of area.sentinels) {
    const absolute = path.resolve(root, sentinel.path);
    assert(
      absolute.startsWith(root + path.sep),
      "Sentinel stays in repository",
    );
    const content = read(sentinel.path);
    for (const needle of sentinel.contains)
      assert(
        content.includes(needle),
        `${sentinel.path} missing preservation anchor ${needle}`,
      );
    sentinels++;
  }
  console.log(`PASS preservation inventory ${area.id}`);
}
for (const file of manifest.mandatoryFiles)
  assert(
    existsSync(path.join(root, file)),
    `Required acceptance file exists: ${file}`,
  );
const skillFile = ".agents/skills/amiro-runtime-update/SKILL.md";
const skill = read(skillFile);
assert.match(
  skill,
  /^---\nname: amiro-runtime-update\ndescription: [^\n]+\n---\n/,
);
assert(
  !skill.includes("disable-model-invocation: true"),
  "Skill remains discoverable for explicit requested use and task matching",
);
const docFile = "docs/runtime-upstream-update.md";
const doc = read(docFile);
for (const rule of [
  "STOP",
  "UPSTREAM_NEW",
  "old-normalized",
  "current-runtime",
  "new-normalized",
  "--locked",
  "verify-runtime-titles.mjs",
  "verify-settings-workflows.mjs",
  "rollback",
  "not already automated",
])
  assert(doc.includes(rule), `Runbook includes ${rule}`);
let links = 0;
for (const file of [skillFile, docFile]) {
  for (const match of read(file).matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1].split("#")[0];
    if (!target || /^(https?:|mailto:)/.test(target)) continue;
    assert(
      existsSync(path.resolve(root, path.dirname(file), target)),
      `${file} link exists: ${target}`,
    );
    links++;
  }
}
console.log(
  `PASS ${sentinels} source sentinels, ${manifest.mandatoryFiles.length} acceptance files, ${links} runbook/skill links`,
);
console.log(
  `INFO normalizer status: ${manifest.normalizer.status}. Structural checks do not approve an upstream import or deployment.`,
);
