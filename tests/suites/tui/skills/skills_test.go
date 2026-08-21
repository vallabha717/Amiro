// Package skills_test tests Agent Skills in the TUI slash command palette.
//
// LOAD-BEARING ASSUMPTION -- STARTUP LOADING:
// internal/tui/page/mentions.go loads skills once at startup alongside mentionables.
// Skills must be planted before the PTY session launches.
package skills_test

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"amiro/tests/harness"
	"amiro/tests/harness/pty"
)

func TestTUI_SlashPalette_ListsBuiltinsAndSkillsGrouped(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"))
	be := h.Backend()

	h.PlantSkill(be.Home, ".agents", "skills-audit", "Audit project skills", "# Audit Skill")
	h.PlantSkill(be.WorkspaceRoot, ".agents", "analyze-repo", "Analyze repo structure", "# Analyze Skill")

	sess := h.PTY(
		harness.PTYAppDataDir(be.AppDataDir),
		harness.PTYDir(be.WorkspaceRoot),
		harness.PTYHome(be.Home),
		harness.PTYDims(180, 60),
	)
	defer sess.Close()

	if err := sess.WaitForText("Ask Amiro", 15*time.Second); err != nil {
		t.Fatalf("TUI prompt did not render: %v\nframe:\n%s", err, sess.Frame())
	}

	if err := sess.Send("/"); err != nil {
		t.Fatalf("sending '/': %v", err)
	}

	if err := sess.WaitForText("/mode", 10*time.Second); err != nil {
		t.Fatalf("palette missing /mode: %v\nframe:\n%s", err, sess.Frame())
	}
	if err := sess.WaitForText("skills", 10*time.Second); err != nil {
		t.Fatalf("palette missing 'skills' heading: %v\nframe:\n%s", err, sess.Frame())
	}
	if err := sess.WaitForText("/analyze-repo", 10*time.Second); err != nil {
		t.Fatalf("palette missing /analyze-repo: %v\nframe:\n%s", err, sess.Frame())
	}
	if err := sess.WaitForText("/skills-audit", 10*time.Second); err != nil {
		t.Fatalf("palette missing /skills-audit: %v\nframe:\n%s", err, sess.Frame())
	}
}

func TestTUI_SlashPalette_PrefixFilteringAndOrdering(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"))
	be := h.Backend()

	h.PlantSkill(be.WorkspaceRoot, ".agents", "example-skill", "Example skill for testing", "# Example")
	h.PlantSkill(be.Home, ".claude", "export", "User skill with colliding name", "# Colliding")

	sess := h.PTY(
		harness.PTYAppDataDir(be.AppDataDir),
		harness.PTYDir(be.WorkspaceRoot),
		harness.PTYHome(be.Home),
		harness.PTYDims(180, 60),
	)
	defer sess.Close()

	if err := sess.WaitForText("Ask Amiro", 15*time.Second); err != nil {
		t.Fatalf("TUI prompt did not render: %v\nframe:\n%s", err, sess.Frame())
	}

	// Type "/e" to filter
	if err := sess.Send("/e"); err != nil {
		t.Fatalf("sending '/e': %v", err)
	}

	if err := sess.WaitForFrame(func(b *pty.Buffer) bool {
		plain := unwrapped(b.Plain())
		return strings.Contains(plain, "/export") && strings.Contains(plain, "/example-skill")
	}, 10*time.Second); err != nil {
		t.Fatalf("palette missing /export or /example-skill: %v\nframe:\n%s", err, sess.Frame())
	}

	// Verify built-in /export appears before /example-skill
	plain := unwrapped(sess.Frame())
	exportIdx := strings.Index(plain, "/export")
	exampleIdx := strings.Index(plain, "/example-skill")
	if exportIdx == -1 || exampleIdx == -1 || exportIdx >= exampleIdx {
		t.Fatalf("expected /export before /example-skill, got exportIdx=%d exampleIdx=%d\nframe:\n%s", exportIdx, exampleIdx, sess.Frame())
	}

	// The colliding skill 'export' must NOT match under '/e' (reachable only as '/skill:export')
	if strings.Contains(plain, "/skill:export") {
		t.Fatalf("colliding skill should not match prefix '/e':\n%s", sess.Frame())
	}
}

func TestTUI_SlashPalette_SkillReservationAndShadowedAccess(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"))
	be := h.Backend()

	h.PlantSkill(be.Home, ".claude", "export", "Shadowed export skill", "# Shadowed")

	sess := h.PTY(
		harness.PTYAppDataDir(be.AppDataDir),
		harness.PTYDir(be.WorkspaceRoot),
		harness.PTYHome(be.Home),
		harness.PTYDims(180, 60),
	)
	defer sess.Close()

	if err := sess.WaitForText("Ask Amiro", 15*time.Second); err != nil {
		t.Fatalf("TUI prompt did not render: %v\nframe:\n%s", err, sess.Frame())
	}

	// Type "/skill:exp" to reach the shadowed skill
	if err := sess.Send("/skill:exp"); err != nil {
		t.Fatalf("sending '/skill:exp': %v", err)
	}

	if err := sess.WaitForFrame(func(b *pty.Buffer) bool {
		return strings.Contains(unwrapped(b.Plain()), "/skill:export")
	}, 10*time.Second); err != nil {
		t.Fatalf("palette missing /skill:export: %v\nframe:\n%s", err, sess.Frame())
	}

	// Tab-accept the skill
	if err := sess.SendKey(pty.KeyTab, "tab"); err != nil {
		t.Fatalf("sending Tab: %v", err)
	}

	// After Tab, status bar line must explicitly contain "skill:export"
	if err := sess.WaitForFrame(func(b *pty.Buffer) bool {
		lines := strings.Split(b.Plain(), "\n")
		var statusBarLine string
		for i := len(lines) - 1; i >= 0; i-- {
			if strings.Contains(lines[i], "enter to send") && strings.Contains(lines[i], "·") {
				statusBarLine = lines[i]
				break
			}
		}
		return strings.Contains(statusBarLine, "skill:export")
	}, 10*time.Second); err != nil {
		t.Fatalf("status bar line missing 'skill:export': %v\nframe:\n%s", err, sess.Frame())
	}
}

func TestTUI_SlashPalette_TabAccept_ShowsInStatusBarAndMentions(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"))
	be := h.Backend()

	h.PlantSkill(be.WorkspaceRoot, ".agents", "doc-reader", "Reads documentation files", "# Doc Reader")

	sess := h.PTY(
		harness.PTYAppDataDir(be.AppDataDir),
		harness.PTYDir(be.WorkspaceRoot),
		harness.PTYHome(be.Home),
		harness.PTYDims(180, 60),
	)
	defer sess.Close()

	if err := sess.WaitForText("Ask Amiro", 15*time.Second); err != nil {
		t.Fatalf("TUI prompt did not render: %v\nframe:\n%s", err, sess.Frame())
	}

	// Type "/doc-r" and press Tab
	if err := sess.Send("/doc-r"); err != nil {
		t.Fatalf("sending '/doc-r': %v", err)
	}
	if err := sess.WaitForFrame(func(b *pty.Buffer) bool {
		return strings.Contains(unwrapped(b.Plain()), "/doc-reader")
	}, 10*time.Second); err != nil {
		t.Fatalf("suggestion missing /doc-reader: %v\nframe:\n%s", err, sess.Frame())
	}
	if err := sess.SendKey(pty.KeyTab, "tab"); err != nil {
		t.Fatalf("sending Tab: %v", err)
	}

	// Status bar must display skill:doc-reader in the status bar specifically
	if err := sess.WaitForFrame(func(b *pty.Buffer) bool {
		lines := strings.Split(b.Plain(), "\n")
		var statusBarLine string
		for i := len(lines) - 1; i >= 0; i-- {
			if strings.Contains(lines[i], "enter to send") && strings.Contains(lines[i], "·") {
				statusBarLine = lines[i]
				break
			}
		}
		return strings.Contains(statusBarLine, "skill:doc-reader")
	}, 10*time.Second); err != nil {
		t.Fatalf("status bar line missing 'skill:doc-reader': %v\nframe:\n%s", err, sess.Frame())
	}

	// Send a chat message
	if err := sess.SendLine("summarize docs"); err != nil {
		t.Fatalf("sending line: %v", err)
	}

	// Wait for completion
	if err := sess.WaitForText("Ask Amiro", 15*time.Second); err != nil {
		t.Fatalf("turn did not complete: %v\nframe:\n%s", err, sess.Frame())
	}
}

func TestTUI_SlashSkills_Command_RendersSourceAndScope(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"))
	be := h.Backend()

	h.PlantSkill(be.WorkspaceRoot, ".agents", "proj-skill", "Project skill description", "# Proj")
	h.PlantSkill(be.Home, ".claude", "user-skill", "User skill description", "# User")

	sess := h.PTY(
		harness.PTYAppDataDir(be.AppDataDir),
		harness.PTYDir(be.WorkspaceRoot),
		harness.PTYHome(be.Home),
		harness.PTYDims(180, 60),
	)
	defer sess.Close()

	if err := sess.WaitForText("Ask Amiro", 15*time.Second); err != nil {
		t.Fatalf("TUI prompt did not render: %v\nframe:\n%s", err, sess.Frame())
	}

	// Run /skills
	if err := sess.SendLine("/skills"); err != nil {
		t.Fatalf("sending '/skills': %v", err)
	}

	if err := sess.WaitForFrame(func(b *pty.Buffer) bool {
		plain := unwrapped(b.Plain())
		return strings.Contains(plain, "skills:") &&
			strings.Contains(plain, "proj-skill (.agents, project)") &&
			strings.Contains(plain, "user-skill (.claude, user)")
	}, 10*time.Second); err != nil {
		t.Fatalf("notice missing skills details: %v\nframe:\n%s", err, sess.Frame())
	}
}

func TestTUI_SlashPalette_ZeroSkills_LeavesPaletteUnchanged(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"))
	be := h.Backend()

	sess := h.PTY(
		harness.PTYAppDataDir(be.AppDataDir),
		harness.PTYDir(be.WorkspaceRoot),
		harness.PTYHome(be.Home),
		harness.PTYDims(180, 60),
	)
	defer sess.Close()

	if err := sess.WaitForText("Ask Amiro", 15*time.Second); err != nil {
		t.Fatalf("TUI prompt did not render: %v\nframe:\n%s", err, sess.Frame())
	}

	if err := sess.Send("/"); err != nil {
		t.Fatalf("sending '/': %v", err)
	}

	if err := sess.WaitForFrame(func(b *pty.Buffer) bool {
		plain := unwrapped(b.Plain())
		return strings.Contains(plain, "/mode") && strings.Contains(plain, "/threads")
	}, 10*time.Second); err != nil {
		t.Fatalf("palette missing /mode or /threads: %v\nframe:\n%s", err, sess.Frame())
	}

	// With 0 dynamic skills, no standalone 'skills' section heading should appear
	lines := strings.Split(sess.Frame(), "\n")
	for _, l := range lines {
		if strings.TrimSpace(l) == "skills" {
			t.Fatalf("unexpected 'skills' section heading in zero-skills palette:\n%s", sess.Frame())
		}
	}
}

func TestTUI_SlashPalette_FortySkills_CappedWithMoreLine(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"))
	be := h.Backend()

	for i := 0; i < 40; i++ {
		name := fmt.Sprintf("extra-skill-%02d", i)
		h.PlantSkill(be.WorkspaceRoot, ".agents", name, "Extra skill description", "# Extra")
	}

	sess := h.PTY(
		harness.PTYAppDataDir(be.AppDataDir),
		harness.PTYDir(be.WorkspaceRoot),
		harness.PTYHome(be.Home),
		harness.PTYDims(180, 60),
	)
	defer sess.Close()

	if err := sess.WaitForText("Ask Amiro", 15*time.Second); err != nil {
		t.Fatalf("TUI prompt did not render: %v\nframe:\n%s", err, sess.Frame())
	}

	if err := sess.Send("/"); err != nil {
		t.Fatalf("sending '/': %v", err)
	}

	if err := sess.WaitForFrame(func(b *pty.Buffer) bool {
		return strings.Contains(unwrapped(b.Plain()), "more")
	}, 10*time.Second); err != nil {
		t.Fatalf("palette missing '+N more' cap: %v\nframe:\n%s", err, sess.Frame())
	}
	if !sess.Contains("Ask Amiro") {
		t.Fatalf("composer prompt hidden by suggestion list:\n%s", sess.Frame())
	}
}

func unwrapped(frame string) string {
	return strings.ReplaceAll(frame, "\n", "")
}

