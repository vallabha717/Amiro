# Scratch Edit Probe

- The repo map is an Aider-style ranked, budgeted outline of the symbols a codebase defines and where they live.
- Go files are parsed with `go/parser`; every other language uses line-oriented declaration patterns.
- Files are ranked with PageRank (damping 0.85, 24 iterations), with an optional focus vector to personalize the ranking.
- Test files are demoted rather than excluded, and dependency/build directories are always skipped.
