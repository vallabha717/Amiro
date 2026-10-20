#!/usr/bin/env bash
# Link this repo's shared agent skills into every global skill folder, so any
# agent on this machine (Claude Code, jcode / the Amiro runtime, tools that read
# ~/.agents) loads them from any directory — always the repo's current copy.
#
#   scripts/install-global-skills.sh            install / refresh links
#   scripts/install-global-skills.sh --check    show where each link points
#   scripts/install-global-skills.sh --remove   remove only links this script made
#
# Targets: ~/.agents/skills, ~/.claude/skills, ~/.jcode/skills
# (override with AMIRO_SKILL_TARGETS="dir1 dir2"). Never replaces a real
# directory or a link pointing somewhere else; it reports and skips instead.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKILLS=(develop-feature amiro-standards backend ui test e2e-journeys)
TARGETS=(${AMIRO_SKILL_TARGETS:-"$HOME/.agents/skills" "$HOME/.claude/skills" "$HOME/.jcode/skills"})
MODE="${1:-install}"

for skill in "${SKILLS[@]}"; do
  src="$REPO_ROOT/.agents/skills/$skill"
  [ -f "$src/SKILL.md" ] || { echo "missing $src/SKILL.md" >&2; exit 1; }
  for dir in "${TARGETS[@]}"; do
    dest="$dir/$skill"
    case "$MODE" in
      --check)
        if [ -L "$dest" ]; then echo "$dest -> $(readlink "$dest")"
        elif [ -e "$dest" ]; then echo "$dest (real directory, not managed)"
        else echo "$dest (not installed)"; fi
        ;;
      --remove)
        if [ -L "$dest" ] && [ "$(readlink "$dest")" = "$src" ]; then rm "$dest"; echo "removed $dest"; fi
        ;;
      install|--install)
        mkdir -p "$dir"
        if [ -L "$dest" ]; then
          if [ "$(readlink "$dest")" = "$src" ]; then echo "ok      $dest"; continue; fi
          echo "skip    $dest (links to $(readlink "$dest"))"; continue
        fi
        if [ -e "$dest" ]; then echo "skip    $dest (a real directory exists; move it away first)"; continue; fi
        ln -s "$src" "$dest"
        echo "linked  $dest -> $src"
        ;;
      *) echo "usage: $0 [--check|--remove]" >&2; exit 2 ;;
    esac
  done
done
