// Package skills_test proves Phase 3's cross-surface journey:
// dynamic skills discovered in project and user locations are visible
// identically in the dashboard API and the TUI slash command palette.
//
// LOAD-BEARING ASSUMPTION -- STARTUP LOADING:
// internal/tui/page/mentions.go loads skills once at startup (loadSkills).
// Skills must be planted before the PTY session is launched.
package skills_test

import (
	"context"
	"strings"
	"testing"
	"time"

	"amiro/tests/harness"
	"amiro/tests/harness/pty"
)

func TestCrossSurface_SkillsDiscoveredByDashboardAreOfferedByTUISlashPalette(t *testing.T) {
	const projSkillName = "cross-proj-skill"
	const userSkillName = "cross-user-skill"

	h := harness.New(t, harness.Tags("smoke"))
	be := h.Backend()

	// 1. Plant skills in both user ($HOME/.agents/skills) and project (workspace/.agents/skills)
	h.PlantSkill(be.WorkspaceRoot, ".agents", projSkillName, "Project scope skill description", "# Project Skill")
	h.PlantSkill(be.Home, ".agents", userSkillName, "User scope skill description", "# User Skill")

	// 2. Query dashboard API client (GET /api/skills?project=...)
	browser := h.As("admin")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	listResp, err := browser.ListSkills(ctx, be.WorkspaceRoot)
	if err != nil {
		t.Fatalf("dashboard ListSkills API failed: %v", err)
	}

	// Collect all expected skill names from dashboard API
	expectedSkills := make(map[string]bool)
	for _, it := range listResp.Items {
		expectedSkills[it.Name] = true
	}
	if len(expectedSkills) != 2 || !expectedSkills[projSkillName] || !expectedSkills[userSkillName] {
		t.Fatalf("dashboard API did not return expected skills: %+v", listResp.Items)
	}

	// 3. Launch TUI in real PTY and verify both skills are offered in '/' palette
	sess := h.PTY(
		harness.PTYAppDataDir(be.AppDataDir),
		harness.PTYDir(be.WorkspaceRoot),
		harness.PTYHome(be.Home),
		harness.PTYDims(180, 60),
	)
	defer sess.Close()

	if err := sess.WaitForText("Ask Amiro", 15*time.Second); err != nil {
		t.Fatalf("TUI did not render prompt: %v\nframe:\n%s", err, sess.Frame())
	}

	if err := sess.Send("/cross-"); err != nil {
		t.Fatalf("sending '/cross-': %v", err)
	}

	// Bi-directional assertion:
	// 1. Every expected skill from the dashboard API must appear in the TUI palette.
	// 2. No unexpected / phantom skill may appear in the TUI palette.
	builtins := map[string]bool{
		"mode": true, "threads": true, "models": true, "settings": true,
		"compact": true, "export": true, "skills": true, "help": true,
	}

	if err := sess.WaitForFrame(func(b *pty.Buffer) bool {
		plain := unwrapped(b.Plain())
		// 1. Check all expected skills are rendered
		for name := range expectedSkills {
			if !strings.Contains(plain, "/"+name) {
				return false
			}
		}
		// 2. Check no unexpected slash skill is rendered
		words := strings.Fields(plain)
		for _, w := range words {
			if strings.HasPrefix(w, "/") {
				token := strings.TrimPrefix(w, "/")
				token = strings.Trim(token, " :;,\t\n\r")
				if token == "" || token == "cross-" || builtins[token] {
					continue
				}
				if strings.HasPrefix(token, "cross-") && !expectedSkills[token] {
					return false
				}
			}
		}
		return true
	}, 10*time.Second); err != nil {
		t.Fatalf("TUI slash palette skills set did not equal dashboard API skills set (expected %+v): %v\nframe:\n%s",
			expectedSkills, err, sess.Frame())
	}
}

func unwrapped(frame string) string {
	return strings.ReplaceAll(frame, "\n", "")
}

