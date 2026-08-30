package skills_test

import (
	"os"
	"path/filepath"
	"testing"

	"amiro/tests/harness"
	"amiro/tests/harness/apiclient"
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

// TestDesktop_CreatingSkillWritesUnderSidecarHomeAndIsListed proves Phase
// 5's authoring API works end to end inside the packaged app's sidecar
// process, not just its read endpoints (the test above): POST /api/skills
// through the untagged sidecar build writes SKILL.md under *that
// sidecar's* isolated $HOME -- internal/skills/write.go's WritableRoot,
// per Phase 4 -- and GET /api/skills lists it back immediately.
func TestDesktop_CreatingSkillWritesUnderSidecarHomeAndIsListed(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"))
	user := h.As("user")
	be := h.Backend()

	const skillName = "desktop-created-skill"
	created, err := user.CreateSkill(t.Context(), apiclient.SkillWriteRequest{
		Name:        skillName,
		Description: "Created through the sidecar's authoring API",
		Body:        "# Desktop Created Skill\n\nInstructions body.",
	})
	if err != nil {
		t.Fatalf("CreateSkill on untagged sidecar: %v", err)
	}
	if created.Skill.Name != skillName || !created.Skill.Writable {
		t.Fatalf("CreateSkill response = %+v, want writable skill named %q", created.Skill, skillName)
	}

	// The file must exist under this sidecar's isolated $HOME, never a
	// real user's home directory -- see the test skill's "Isolation you
	// get, and must not break" rule.
	skillPath := filepath.Join(be.Home, ".agents", "skills", skillName, "SKILL.md")
	if _, err := os.Stat(skillPath); err != nil {
		t.Fatalf("SKILL.md not written under sidecar $HOME at %s: %v", skillPath, err)
	}

	resp, err := user.ListSkills(t.Context())
	if err != nil {
		t.Fatalf("ListSkills after create: %v", err)
	}
	found := false
	for _, it := range resp.Items {
		if it.Name == skillName {
			found = true
		}
	}
	if !found {
		t.Fatalf("desktop-created skill not listed by GET /api/skills afterwards: %+v", resp.Items)
	}
}
