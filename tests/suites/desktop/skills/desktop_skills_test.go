package skills_test

import (
	"os"
	"path/filepath"
	"testing"

	"amiro/tests/harness"
)

func TestDesktop_UntaggedSidecarServesSkillsAndDiscoversHome(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"))
	user := h.As("user")
	be := h.Backend()

	// Plant user-scope skill in $HOME
	userSkillsDir := filepath.Join(be.Home, ".agents", "skills", "desktop-skill")
	if err := os.MkdirAll(userSkillsDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	skillMD := filepath.Join(userSkillsDir, "SKILL.md")
	content := "---\nname: desktop-skill\ndescription: Desktop user scope skill\n---\n# Desktop Skill Body\n"
	if err := os.WriteFile(skillMD, []byte(content), 0o644); err != nil {
		t.Fatalf("writeFile: %v", err)
	}

	resp, err := user.ListSkills(t.Context())
	if err != nil {
		t.Fatalf("ListSkills on untagged sidecar: %v", err)
	}

	found := false
	for _, it := range resp.Items {
		if it.Name == "desktop-skill" {
			found = true
			if it.Scope != "user" {
				t.Errorf("scope = %q, want user", it.Scope)
			}
			if it.Source != ".agents" {
				t.Errorf("source = %q, want .agents", it.Source)
			}
			if !it.Writable {
				t.Errorf("writable = false, want true for user .agents skill")
			}
		}
	}
	if !found {
		t.Fatalf("desktop-skill not discovered by untagged sidecar in $HOME: %+v", resp.Items)
	}

	// Also verify GetSkill on the desktop sidecar
	skill, err := user.GetSkill(t.Context(), "desktop-skill")
	if err != nil {
		t.Fatalf("GetSkill: %v", err)
	}
	if skill.Name != "desktop-skill" || skill.Description != "Desktop user scope skill" {
		t.Errorf("GetSkill returned unexpected data: %+v", skill)
	}
}
