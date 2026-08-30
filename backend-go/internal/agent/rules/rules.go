// Package rules reads a project's always-on instructions file, AGENTS.md.
//
// This is the load-bearing distinction docs/coding-agent-parity/
// 01-workspace-trust-and-rules.md draws: AGENTS.md is read every turn,
// unconditionally, for the handful of standing facts a project wants an
// agent to always know ("use pnpm", "the API lives in internal/api"). A
// Skill (internal/skills) activates on demand instead -- conflating the two
// by reading every skill body on every turn "to be safe" is exactly what
// Skills' progressive-disclosure principle exists to prevent, and this
// package must not reintroduce it through a second door.
package rules

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// MaxRulesLen caps AGENTS.md's contribution to the system prompt in runes.
// A truncation notice beats a silently-clipped prompt -- the same reasoning
// internal/ai/tools' read_file windowing already applies.
const MaxRulesLen = 8192

// candidatePaths lists where AGENTS.md may live, in the order the design
// doc specifies: first match wins, the same project-then-fallback
// precedence shape internal/tui/config's .amiro/config.yaml lookup already
// uses.
func candidatePaths(root string) []string {
	return []string{
		filepath.Join(root, "AGENTS.md"),
		filepath.Join(root, ".agents", "AGENTS.md"),
	}
}

// Report details what Build actually read, for the caller's own
// truncation-notice event -- the same shape
// prompts.SkillCatalogReport reports for the skills catalog.
type Report struct {
	// Path is the candidate Build read, or "" if neither existed.
	Path string
	// Truncated is whether the file's content was cut to MaxRulesLen runes.
	Truncated bool
}

// Build reads root's AGENTS.md (or .agents/AGENTS.md) into a system-prompt
// block. A missing file is not an error -- "malformed nothing" is this
// package's whole failure-mode story, per the design doc: there is no
// schema to violate, so nothing found just means nothing is added to the
// prompt.
func Build(root string) (string, Report) {
	if strings.TrimSpace(root) == "" {
		return "", Report{}
	}
	for _, path := range candidatePaths(root) {
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		content, truncated := truncateRunes(string(data), MaxRulesLen)
		if strings.TrimSpace(content) == "" {
			return "", Report{Path: path}
		}

		var sb strings.Builder
		sb.WriteString("<project_rules>\n")
		sb.WriteString(content)
		if truncated {
			sb.WriteString("\n\n[AGENTS.md truncated at ")
			sb.WriteString(strconv.Itoa(MaxRulesLen))
			sb.WriteString(" characters]")
		}
		sb.WriteString("\n</project_rules>")
		return sb.String(), Report{Path: path, Truncated: truncated}
	}
	return "", Report{}
}

func truncateRunes(s string, maxRunes int) (string, bool) {
	runes := []rune(s)
	if len(runes) > maxRunes {
		return string(runes[:maxRunes]), true
	}
	return s, false
}
