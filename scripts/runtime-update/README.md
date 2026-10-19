# Runtime upstream update tooling

`normalize_upstream.py` is the versioned structural transform that
`docs/runtime-upstream-update.md` §5 requires: it turns an exported upstream
jcode tree into the shape of Amiro's `runtime/` (same file selection as
`runtime/PROVENANCE.md`, `jcode → amiro` path/identifier renames) **without**
any Amiro behavioural patches. Those come from the three-way merge.

`keep-tokens.json` holds what the original vendoring decided, learned from
upstream `11952e02` vs Amiro's vendor commit `de88011`:

- `keep_tokens`: occurrences that stayed `jcode` (upstream URLs, `~/.jcode`
  compatibility paths, subscription/provider ids, release asset names, wire
  headers, telemetry endpoints, licence text).
- `rename_tokens`: everything else that existed upstream at that commit.
- The bare string literal `"jcode"` is always kept; bare `jcode` in prose or
  commands is renamed.

Tokens upstream introduced later are classified by `KEEP_PATTERNS` in the
script and **listed in the report** (`new_tokens_kept_by_rule`,
`new_tokens_renamed`) for review before merging.

## Use

```bash
UR=/path/outside/the/repo        # private update workspace
git clone https://github.com/1jehuang/jcode.git "$UR/upstream"
mkdir "$UR/old-raw" "$UR/new-raw"
git -C "$UR/upstream" archive <UPSTREAM_OLD> | tar -x -C "$UR/old-raw"
git -C "$UR/upstream" archive <UPSTREAM_NEW> | tar -x -C "$UR/new-raw"
python3 scripts/runtime-update/normalize_upstream.py "$UR/old-raw" "$UR/old-normalized" --report "$UR/old.json"
python3 scripts/runtime-update/normalize_upstream.py "$UR/new-raw" "$UR/new-normalized" --report "$UR/new.json"
# then the three-way merge in docs/runtime-upstream-update.md §6
```

Running it twice on the same input gives the same `tree_sha256` (checked).
After a successful update, re-learn `keep-tokens.json` against the new
baseline so the next update starts from accepted decisions.

## Transform history

| Version | Change |
| --- | --- |
| 1 | Initial: selection rules, learned keep list, `"jcode"` literal rule |
| 2 | Learned rename decisions take precedence over keep patterns (fixes `X-Jcode-Jev-Purpose`, which the vendoring renamed); rename list covers every upstream token |
