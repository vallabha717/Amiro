# large workspace fixture

Exists for one thing: `suites/backend/perf`'s "Repomap over
`fixtures/workspaces/large` | < 5s" budget
(`docs/testing/phases/phase-07-cross-surface.md`). `basic/` is
deliberately boring and small; this is deliberately large enough that
`repomap.Build` has real work to do -- parsing, cross-file ref counting,
pagerank, budget-driven truncation -- rather than finishing instantly on a
handful of files.

**Deterministic and committed, not generated at test time.** 600 Go
files across 25 packages (`_pkg000/` .. `_pkg024/`), 8 functions each
(4,800 symbols total), every function body calling one function in the
next package in sequence -- pure text, `go/parser`-valid syntax, but not
buildable as a real program (no imports, no module wiring for the cross-
package calls). That does not matter: `repomap.Build` parses each file
independently with `go/parser` for declarations, and counts refs via a
textual token scan (`repomap.go`'s `tokenize`), so it never needs these
packages to compile. The cross-package call pattern exists so the
pagerank/refs step has real edges to walk instead of 600 files each
defining symbols nothing else in the fixture ever mentions.

**The leading underscore on each package directory is load-bearing, not
cosmetic.** `tests/` is itself a Go module; without it, `go build ./...`,
`go vet ./...` and `go test ./...` run from `tests/` would try to compile
these 600 files as real packages and fail on the very cross-package calls
described above (undefined symbols -- there are no imports). The Go
toolchain skips any directory named `_*` at any depth (`go help
packages`), so `_pkg000/` etc. are invisible to it. `repomap.Build`'s own
walker does not apply that convention -- it only skips `.`-prefixed
directories (`repomap.go`'s `alwaysSkipped`/`HasPrefix` check) -- so it
still walks and parses every file here normally.

Regenerate with `python3 gen.py` (also in this directory) if the shape
ever needs to change -- output is fully deterministic (no randomness, no
seed), so a regeneration produces byte-identical files.

600 files stays comfortably under `repomap`'s own `defaultMaxFiles`
(4,000), so a `Build` over this fixture is never `Partial` -- the whole
budget being asserted is the ranking/truncation logic's own cost, not the
file-walk simply giving up early.
