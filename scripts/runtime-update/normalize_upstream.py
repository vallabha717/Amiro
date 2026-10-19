#!/usr/bin/env python3
"""Normalize an upstream jcode checkout into Amiro's vendored `runtime/` shape.

This is the versioned "structural rebrand + exclusion" transform required by
docs/runtime-upstream-update.md section 5. It is deliberately boring and
deterministic:

  1. Path selection   : the same include/exclude rules as runtime/PROVENANCE.md.
  2. Path rename      : jcode -> amiro (Jcode -> Amiro, JCODE -> AMIRO).
  3. Content rename   : every jcode/Jcode/JCODE occurrence is renamed EXCEPT
       - tokens in keep-tokens.json (learned from the original vendoring:
         upstream URLs, ~/.jcode compatibility paths, subscription/provider
         ids, release asset names, wire headers, telemetry endpoints), and
       - the exact string literal "jcode" (provider id / argv0 / dir name).
     Tokens never seen before are classified by KEEP_PATTERNS and listed in
     the report so a reviewer can confirm them.

It never applies Amiro behavioural patches; those come from the three-way
merge with the tracked runtime/ tree.

Usage:
  normalize_upstream.py <upstream-export-dir> <out-dir> [--report report.json]
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import sys

TRANSFORM_VERSION = 3
HERE = os.path.dirname(os.path.abspath(__file__))

# --- 1. path selection (mirrors runtime/PROVENANCE.md) -----------------------
INCLUDE_TOP_FILES = {
    "Cargo.toml", "Cargo.lock", "LICENSE", "README.md", "OAUTH.md", "TELEMETRY.md",
    "CONTRIBUTING.md", "AGENTS.md", "CLAUDE.md",
}
INCLUDE_TOP_DIRS = {"crates", "src", "tests", "changelog", ".cargo"}
INCLUDE_SCRIPTS = {"scripts/rustc-parallel-frontend", "scripts/dev_cargo.sh", "scripts/cargo_exec.sh"}
INCLUDE_ASSET_DIRS = ("assets/app-icons/", "assets/brand/")


def selected(rel: str) -> bool:
    parts = rel.split("/")
    if len(parts) == 1:
        return rel in INCLUDE_TOP_FILES
    top = parts[0]
    if top in INCLUDE_TOP_DIRS:
        return not (top == ".cargo" and rel != ".cargo/config.toml")
    if top == "docs":
        # Only top-level markdown is a build input (amiro-app-core/build.rs).
        return len(parts) == 2 and rel.endswith(".md")
    if top == "scripts":
        return rel in INCLUDE_SCRIPTS
    if top == "assets":
        return rel.startswith(INCLUDE_ASSET_DIRS)
    return False


# --- 2/3. renames --------------------------------------------------------------
ROOT_CRATE_PATH = re.compile(r"(?<![A-Za-z0-9_:])jcode::")


def rename_plain(s: str) -> str:
    # The root library crate is `amiro_runtime`, so `jcode::x` paths map there.
    s = ROOT_CRATE_PATH.sub("amiro_runtime::", s)
    return s.replace("jcode", "amiro").replace("Jcode", "Amiro").replace("JCODE", "AMIRO")


TOKEN = re.compile(r"[A-Za-z0-9_.\-/:~$@]*?(?:jcode|Jcode|JCODE)[A-Za-z0-9_.\-/:@]*")
# Rules for tokens the learned list has never seen (new upstream code).
KEEP_PATTERNS = [
    re.compile(r"jcode\.sh"),                      # product/service URLs
    re.compile(r"github\.com/1jehuang/jcode|1jehuang/jcode"),
    re.compile(r"(^|[/~$])\.jcode(/|$)|^\.jcode"),  # ~/.jcode compatibility home
    re.compile(r"jcode-subscription"),             # subscription provider identity
    re.compile(r"^x-jcode-", re.I),                # wire headers
    re.compile(r"jcode-(linux|macos|windows|darwin)-(x86_64|aarch64|arm64)"),  # release asset names
    re.compile(r"telemetry\.jcode"),
]


class Renamer:
    def __init__(self, keep_tokens: set[str], rename_tokens: set[str]):
        self.keep = keep_tokens
        self.known_renames = rename_tokens
        self.new_kept: dict[str, int] = {}
        self.new_renamed: dict[str, int] = {}

    def _token(self, m: re.Match[str], line: str) -> str:
        tok = m.group(0)
        s, e = m.start(), m.end()
        if tok in ("jcode", "Jcode", "JCODE"):
            quoted = s > 0 and e < len(line) and line[s - 1] == '"' and line[e] == '"'
            return tok if quoted else rename_plain(tok)
        if tok in self.keep:
            return tok
        if tok in self.known_renames:  # learned decisions beat the rules below
            return rename_plain(tok)
        if any(p.search(tok) for p in KEEP_PATTERNS):
            self.new_kept[tok] = self.new_kept.get(tok, 0) + 1
            return tok
        self.new_renamed[tok] = self.new_renamed.get(tok, 0) + 1
        return rename_plain(tok)

    def line(self, line: str) -> str:
        if "jcode" not in line.lower():
            return line
        return TOKEN.sub(lambda m: self._token(m, line), line)

    def text(self, text: str) -> str:
        return "\n".join(self.line(l) for l in text.split("\n"))


def main(argv: list[str]) -> int:
    if len(argv) < 3:
        print(__doc__)
        return 2
    src, out = argv[1], argv[2]
    report_path = argv[argv.index("--report") + 1] if "--report" in argv else None
    learned = json.load(open(os.path.join(HERE, "keep-tokens.json")))
    r = Renamer(set(learned["keep_tokens"]), set(learned.get("rename_tokens", [])))
    if os.path.exists(out):
        print(f"refusing to overwrite {out}", file=sys.stderr)
        return 1
    files = 0
    digest = hashlib.sha256()
    for dp, dn, fn in os.walk(src):
        dn.sort()
        for f in sorted(fn):
            full = os.path.join(dp, f)
            rel = os.path.relpath(full, src).replace(os.sep, "/")
            if not selected(rel):
                continue
            dest_rel = rename_plain(rel)
            dest = os.path.join(out, dest_rel)
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            raw = open(full, "rb").read()
            try:
                data = r.text(raw.decode("utf-8")).encode("utf-8")
            except UnicodeDecodeError:
                data = raw
            with open(dest, "wb") as fh:
                fh.write(data)
            shutil.copymode(full, dest)
            digest.update(dest_rel.encode() + b"\0" + hashlib.sha256(data).digest())
            files += 1
    report = {
        "transform_version": TRANSFORM_VERSION,
        "files": files,
        "tree_sha256": digest.hexdigest(),
        "new_tokens_kept_by_rule": dict(sorted(r.new_kept.items())),
        "new_tokens_renamed": dict(sorted(r.new_renamed.items())),
    }
    if report_path:
        json.dump(report, open(report_path, "w"), indent=1)
    print(json.dumps({k: report[k] for k in ("transform_version", "files", "tree_sha256")}))
    print(f"new tokens kept by rule: {len(r.new_kept)}, new tokens renamed: {len(r.new_renamed)}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
