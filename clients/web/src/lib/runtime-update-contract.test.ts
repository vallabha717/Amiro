import { describe, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "../../../..");
const checker = "scripts/verify-runtime-update-contract.mjs";
const inventory = "docs/runtime-customizations.json";
const manifest = JSON.parse(readFileSync(path.join(root, inventory), "utf8"));
function fixture(run: (directory: string) => void) {
  const directory = mkdtempSync(
    path.join(
      process.env.JCODE_SCRATCH_DIR || os.homedir(),
      "amiro-update-contract-",
    ),
  );
  try {
    const files = new Set<string>([
      checker,
      inventory,
      "runtime/PROVENANCE.md",
      "docs/runtime-upstream-update.md",
      ".agents/skills/amiro-runtime-update/SKILL.md",
      "docs/RUST-RUNTIME.md",
      "docs/runtime-update-validation.md",
      ...manifest.mandatoryFiles,
      ...manifest.areas.flatMap((area: { sentinels: { path: string }[] }) =>
        area.sentinels.map((s) => s.path),
      ),
    ]);
    for (const file of files) {
      const target = path.join(directory, file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, readFileSync(path.join(root, file)));
    }
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
const check = (directory: string) =>
  spawnSync(process.execPath, [path.join(directory, checker)], {
    encoding: "utf8",
  });

describe("runtime update runbook contract", () => {
  it("accepts the actual source inventory and complete skill/runbook", () => {
    const result = check(root);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "Structural checks do not approve an upstream import",
    );
  });
  it("rejects an invalid upstream pin rather than attempting an update", () => {
    fixture((directory) => {
      const changed = structuredClone(manifest);
      changed.recordedUpstreamCommit = "main";
      writeFileSync(path.join(directory, inventory), JSON.stringify(changed));
      expect(check(directory).status).not.toBe(0);
    });
  });
  it("rejects a missing updater protection call site", () => {
    fixture((directory) => {
      const file = path.join(directory, "runtime/src/cli/startup.rs");
      writeFileSync(
        file,
        readFileSync(file, "utf8").replaceAll(
          "upstream_auto_update_enabled",
          "removed_gate",
        ),
      );
      const result = check(directory);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("missing preservation anchor");
    });
  });
  it("rejects missing required acceptance scripts", () => {
    fixture((directory) => {
      rmSync(path.join(directory, "scripts/verify-settings-workflows.mjs"));
      expect(check(directory).status).not.toBe(0);
    });
  });
  it("documented three-way Git merge preserves local edits and stops on conflict", () => {
    const document = readFileSync(
      path.join(root, "docs/runtime-upstream-update.md"),
      "utf8",
    );
    const mergeBlock = [...document.matchAll(/```bash\n([\s\S]*?)\n```/g)].find(
      ([, source]) => source.includes("init --initial-branch=baseline"),
    )?.[1];
    expect(mergeBlock).toBeDefined();
    for (const conflicting of [false, true]) {
      const directory = mkdtempSync(
        path.join(
          process.env.JCODE_SCRATCH_DIR || os.homedir(),
          "amiro-merge-runbook-",
        ),
      );
      try {
        for (const tree of [
          "old-normalized",
          "current-runtime",
          "new-normalized",
        ])
          mkdirSync(path.join(directory, tree));
        writeFileSync(
          path.join(directory, "old-normalized/shared.txt"),
          "baseline\n",
        );
        writeFileSync(
          path.join(directory, "current-runtime/shared.txt"),
          "local-change\n",
        );
        writeFileSync(
          path.join(directory, "new-normalized/shared.txt"),
          conflicting ? "upstream-change\n" : "baseline\n",
        );
        writeFileSync(
          path.join(directory, "new-normalized/new-file.txt"),
          "upstream-addition\n",
        );
        const result = spawnSync(
          "bash",
          ["-c", "set -euo pipefail\n" + mergeBlock],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              UPDATE_ROOT: directory,
              GIT_CONFIG_NOSYSTEM: "1",
              GIT_CONFIG_GLOBAL: "/dev/null",
            },
          },
        );
        if (conflicting) {
          expect(result.status).not.toBe(0);
          expect(result.stderr).toContain("STOP: merge requires review");
          expect(
            spawnSync(
              "git",
              ["-C", path.join(directory, "merge"), "ls-files", "-u"],
              { encoding: "utf8" },
            ).stdout,
          ).not.toBe("");
        } else {
          expect(result.status, result.stderr).toBe(0);
          expect(
            readFileSync(path.join(directory, "merge/shared.txt"), "utf8"),
          ).toBe("local-change\n");
          expect(
            readFileSync(path.join(directory, "merge/new-file.txt"), "utf8"),
          ).toBe("upstream-addition\n");
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });
  it("all documented Bash blocks parse without executing destructive commands", () => {
    const document = readFileSync(
      path.join(root, "docs/runtime-upstream-update.md"),
      "utf8",
    );
    const blocks = [...document.matchAll(/```bash\n([\s\S]*?)\n```/g)];
    expect(blocks.length).toBeGreaterThan(5);
    for (const [, source] of blocks) {
      const result = spawnSync("bash", ["-n"], {
        input: source,
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
    }
  });
});
