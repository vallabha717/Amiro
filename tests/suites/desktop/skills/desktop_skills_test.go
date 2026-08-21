package skills_test

import (
	"testing"

	"amiro/tests/harness"
)

func TestDesktop_UntaggedSidecarServesSkillsAndDiscoversHome(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"))
	user := h.As("user")
	be := h.Backend()

	// Plant user-scope skill in $HOME
	h.PlantSkill(be.Home, ".agents", "desktop-skill", "Desktop user scope skill", "# Desktop Skill Body")

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

	// Plant project-scope skill in workspaceRoot to test ?project= query path used by web palette
	h.PlantSkill(be.WorkspaceRoot, ".agents", "project-desktop-skill", "Desktop project scope skill", "# Project Desktop Skill Body")

	// Verify ?project= query path returns both project and user scope skills
	projResp, err := user.ListSkills(t.Context(), be.WorkspaceRoot)
	if err != nil {
		t.Fatalf("ListSkills with project on untagged sidecar: %v", err)
	}

	foundUser := false
	foundProj := false
	for _, it := range projResp.Items {
		if it.Name == "desktop-skill" {
			foundUser = true
			if it.Scope != "user" {
				t.Errorf("desktop-skill scope = %q, want user", it.Scope)
			}
		}
		if it.Name == "project-desktop-skill" {
			foundProj = true
			if it.Scope != "project" {
				t.Errorf("project-desktop-skill scope = %q, want project", it.Scope)
			}
			if it.Source != ".agents" {
				t.Errorf("project-desktop-skill source = %q, want .agents", it.Source)
			}
		}
	}
	if !foundUser || !foundProj {
		t.Fatalf("ListSkills with ?project= did not discover both skills: foundUser=%v, foundProj=%v, items=%+v", foundUser, foundProj, projResp.Items)
	}
}
