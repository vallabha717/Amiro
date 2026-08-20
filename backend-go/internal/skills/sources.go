// Package skills discovers, parses, resolves and caches Agent Skills across
// the eight scan roots defined in docs/skills/01-discovery-and-precedence.md.
package skills

import (
	"path/filepath"
)

// Scope represents whether a skill originates from a project repo or personal user config.
type Scope string

const (
	ScopeProject Scope = "project"
	ScopeUser    Scope = "user"
)

// SourceRoot defines one of the eight canonical scan locations.
type SourceRoot struct {
	Scope       Scope  `json:"scope"`
	RelPath     string `json:"relPath"` // e.g. ".agents/skills"
	Source      string `json:"source"`  // e.g. ".agents", ".amiro", ".claude", ".codex"
	Writable    bool   `json:"writable"`
	Description string `json:"description"`
}

// Sources is the single authoritative definition of the eight scan roots in precedence order.
// The table in docs/skills/01-discovery-and-precedence.md mirrors this table and is checked
// by a suites/meta guard.
var Sources = []SourceRoot{
	{
		Scope:       ScopeProject,
		RelPath:     filepath.Join(".agents", "skills"),
		Source:      ".agents",
		Writable:    false,
		Description: "Cross-client convention, committed to the repo",
	},
	{
		Scope:       ScopeProject,
		RelPath:     filepath.Join(".amiro", "skills"),
		Source:      ".amiro",
		Writable:    false,
		Description: "Amiro-native project location",
	},
	{
		Scope:       ScopeProject,
		RelPath:     filepath.Join(".claude", "skills"),
		Source:      ".claude",
		Writable:    false,
		Description: "Claude Code project skills",
	},
	{
		Scope:       ScopeProject,
		RelPath:     filepath.Join(".codex", "skills"),
		Source:      ".codex",
		Writable:    false,
		Description: "Codex project skills",
	},
	{
		Scope:       ScopeUser,
		RelPath:     filepath.Join(".agents", "skills"),
		Source:      ".agents",
		Writable:    true,
		Description: "Cross-client convention — the one directory Amiro owns",
	},
	{
		Scope:       ScopeUser,
		RelPath:     filepath.Join(".amiro", "skills"),
		Source:      ".amiro",
		Writable:    false,
		Description: "Amiro-native user location",
	},
	{
		Scope:       ScopeUser,
		RelPath:     filepath.Join(".claude", "skills"),
		Source:      ".claude",
		Writable:    false,
		Description: "Claude Code personal skills",
	},
	{
		Scope:       ScopeUser,
		RelPath:     filepath.Join(".codex", "skills"),
		Source:      ".codex",
		Writable:    false,
		Description: "Codex personal skills",
	},
}
