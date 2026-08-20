package skills_test

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"amiro/backend/internal/skills"
)

func TestParseSkillContent_Valid(t *testing.T) {
	content := []byte(`---
name: test-skill
description: A test skill for discovery.
license: MIT
compatibility: opencode
metadata:
  version: 1.0.0
allowed-tools: bash read_file
disable-model-invocation: true
---
# Test Skill

This is the body of the test skill.
`)

	skill, diags, err := skills.ParseSkillContent(content, "/test/SKILL.md", "test-skill")
	if err != nil {
		t.Fatalf("ParseSkillContent: %v", err)
	}
	if len(diags) != 0 {
		t.Errorf("expected 0 diags, got %d: %+v", len(diags), diags)
	}
	if skill.Name != "test-skill" {
		t.Errorf("Name = %q, want test-skill", skill.Name)
	}
	if skill.Description != "A test skill for discovery." {
		t.Errorf("Description = %q", skill.Description)
	}
	if skill.License != "MIT" {
		t.Errorf("License = %q, want MIT", skill.License)
	}
	if !skill.DisableModelInvocation {
		t.Errorf("DisableModelInvocation = false, want true")
	}
	if len(skill.AllowedTools) != 2 || skill.AllowedTools[0] != "bash" || skill.AllowedTools[1] != "read_file" {
		t.Errorf("AllowedTools = %+v, want [bash read_file]", skill.AllowedTools)
	}
	if skill.Metadata["version"] != "1.0.0" {
		t.Errorf("Metadata[version] = %q, want 1.0.0", skill.Metadata["version"])
	}
	if skill.Body != "# Test Skill\n\nThis is the body of the test skill." {
		t.Errorf("Body = %q", skill.Body)
	}
}

func TestParseSkillContent_ColonInDescriptionRetry(t *testing.T) {
	content := []byte(`---
name: colon-skill
description: Use when: the user asks about something
---
Body text
`)

	skill, _, err := skills.ParseSkillContent(content, "/test/SKILL.md", "colon-skill")
	if err != nil {
		t.Fatalf("ParseSkillContent failed with retry: %v", err)
	}
	if skill.Description != "Use when: the user asks about something" {
		t.Errorf("Description = %q, want 'Use when: the user asks about something'", skill.Description)
	}
}

func TestParseSkillContent_MissingDescriptionFails(t *testing.T) {
	content := []byte(`---
name: no-desc
---
Body text
`)

	_, diags, err := skills.ParseSkillContent(content, "/test/SKILL.md", "no-desc")
	if err == nil {
		t.Fatalf("expected error for missing description, got nil")
	}
	if len(diags) == 0 || diags[0].Severity != "error" {
		t.Errorf("expected error diagnostic, got %+v", diags)
	}
}

func TestParseSkillContent_MissingNameUsesDirName(t *testing.T) {
	content := []byte(`---
description: Valid description
---
Body
`)

	skill, diags, err := skills.ParseSkillContent(content, "/test/SKILL.md", "fallback-dir")
	if err != nil {
		t.Fatalf("ParseSkillContent: %v", err)
	}
	if skill.Name != "fallback-dir" {
		t.Errorf("Name = %q, want fallback-dir", skill.Name)
	}
	if len(diags) == 0 || diags[0].Severity != "warning" {
		t.Errorf("expected warning diagnostic for missing name, got %+v", diags)
	}
}

func TestDiscovery_PrecedenceAndShadowing(t *testing.T) {
	tmpDir := t.TempDir()
	homeDir := filepath.Join(tmpDir, "home")
	projDir := filepath.Join(tmpDir, "proj")

	// Create user-scope skills:
	// ~/.agents/skills/shared-skill
	// ~/.claude/skills/shared-skill
	// ~/.agents/skills/user-only
	// ~/.codex/skills/same-scope-tie
	// ~/.amiro/skills/same-scope-tie
	userAgents := filepath.Join(homeDir, ".agents", "skills", "shared-skill")
	userClaude := filepath.Join(homeDir, ".claude", "skills", "shared-skill")
	userOnly := filepath.Join(homeDir, ".agents", "skills", "user-only")
	userCodexTie := filepath.Join(homeDir, ".codex", "skills", "same-scope-tie")
	userAmiroTie := filepath.Join(homeDir, ".amiro", "skills", "same-scope-tie")

	// Create project-scope skills:
	// <proj>/.agents/skills/shared-skill  (should beat user-scope)
	// <proj>/.amiro/skills/proj-only
	projAgents := filepath.Join(projDir, ".agents", "skills", "shared-skill")
	projAmiro := filepath.Join(projDir, ".amiro", "skills", "proj-only")

	dirs := []string{userAgents, userClaude, userOnly, userCodexTie, userAmiroTie, projAgents, projAmiro}
	for _, d := range dirs {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
		skillMD := filepath.Join(d, "SKILL.md")
		name := filepath.Base(d)
		content := "---\nname: " + name + "\ndescription: Description for " + name + "\n---\nBody\n"
		if err := os.WriteFile(skillMD, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	svc := skills.NewService()
	res, err := svc.List(context.Background(), homeDir, projDir)
	if err != nil {
		t.Fatalf("List: %v", err)
	}

	// Verify shared-skill is won by project scope .agents
	var sharedSkill *skills.Skill
	var sameScopeTie *skills.Skill
	for i := range res.Items {
		if res.Items[i].Name == "shared-skill" {
			sharedSkill = &res.Items[i]
		}
		if res.Items[i].Name == "same-scope-tie" {
			sameScopeTie = &res.Items[i]
		}
	}

	if sharedSkill == nil {
		t.Fatalf("shared-skill not found in result items: %+v", res.Items)
	}
	if sharedSkill.Scope != skills.ScopeProject {
		t.Errorf("sharedSkill.Scope = %q, want project", sharedSkill.Scope)
	}
	if sharedSkill.Source != ".agents" {
		t.Errorf("sharedSkill.Source = %q, want .agents", sharedSkill.Source)
	}
	// Should shadow the user-scope instances (from ~/.agents and ~/.claude)
	if len(sharedSkill.Shadows) < 2 {
		t.Errorf("sharedSkill.Shadows count = %d, want at least 2: %+v", len(sharedSkill.Shadows), sharedSkill.Shadows)
	}

	// Verify sameScopeTie is won by .amiro over .codex in user scope
	if sameScopeTie == nil {
		t.Fatalf("same-scope-tie not found in result items: %+v", res.Items)
	}
	if sameScopeTie.Source != ".amiro" {
		t.Errorf("sameScopeTie.Source = %q, want .amiro", sameScopeTie.Source)
	}
	if len(sameScopeTie.Shadows) != 1 || sameScopeTie.Shadows[0].Source != ".codex" {
		t.Errorf("sameScopeTie.Shadows = %+v, want 1 entry from .codex", sameScopeTie.Shadows)
	}
}

func TestDiscovery_SymlinkDedup(t *testing.T) {
	tmpDir := t.TempDir()
	homeDir := filepath.Join(tmpDir, "home")

	targetDir := filepath.Join(homeDir, ".agents", "skills", "sym-skill")
	if err := os.MkdirAll(targetDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(targetDir, "SKILL.md"), []byte("---\nname: sym-skill\ndescription: Symlink test\n---\nBody"), 0o644); err != nil {
		t.Fatal(err)
	}

	// Symlink from ~/.claude/skills/sym-skill -> ~/.agents/skills/sym-skill
	claudeSkillsDir := filepath.Join(homeDir, ".claude", "skills")
	if err := os.MkdirAll(claudeSkillsDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(targetDir, filepath.Join(claudeSkillsDir, "sym-skill")); err != nil {
		t.Fatal(err)
	}

	svc := skills.NewService()
	res, err := svc.List(context.Background(), homeDir, "")
	if err != nil {
		t.Fatalf("List: %v", err)
	}

	count := 0
	for _, item := range res.Items {
		if item.Name == "sym-skill" {
			count++
			if item.Source != ".agents" {
				t.Errorf("winner source = %q, want .agents", item.Source)
			}
			if len(item.Shadows) != 0 {
				t.Errorf("identity duplicate should not be recorded as shadowed: %+v", item.Shadows)
			}
		}
	}
	if count != 1 {
		t.Errorf("expected sym-skill to appear exactly 1 time, appeared %d times", count)
	}
}

func TestService_InvalidationIsExplicit(t *testing.T) {
	tmpDir := t.TempDir()
	homeDir := filepath.Join(tmpDir, "home")
	projDir := filepath.Join(tmpDir, "project")

	skill1Dir := filepath.Join(homeDir, ".agents", "skills", "skill-one")
	if err := os.MkdirAll(skill1Dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(skill1Dir, "SKILL.md"), []byte("---\nname: skill-one\ndescription: Skill one\n---\nBody"), 0o644); err != nil {
		t.Fatal(err)
	}

	svc := skills.NewService()
	ctx := context.Background()

	// Initial list: 1 skill
	res1, err := svc.List(ctx, homeDir, projDir)
	if err != nil {
		t.Fatalf("first list: %v", err)
	}
	if len(res1.Items) != 1 {
		t.Fatalf("res1.Items = %d, want 1", len(res1.Items))
	}

	// Plant second skill on disk
	skill2Dir := filepath.Join(homeDir, ".agents", "skills", "skill-two")
	if err := os.MkdirAll(skill2Dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(skill2Dir, "SKILL.md"), []byte("---\nname: skill-two\ndescription: Skill two\n---\nBody"), 0o644); err != nil {
		t.Fatal(err)
	}

	// Cached list without invalidation: still 1 skill
	res2, err := svc.List(ctx, homeDir, projDir)
	if err != nil {
		t.Fatalf("second list: %v", err)
	}
	if len(res2.Items) != 1 {
		t.Errorf("res2.Items = %d, want 1 (cached)", len(res2.Items))
	}

	// Invalidate specific cache key: now discovers 2 skills immediately with no sleep
	svc.Invalidate(homeDir, projDir)

	res3, err := svc.List(ctx, homeDir, projDir)
	if err != nil {
		t.Fatalf("third list: %v", err)
	}
	if len(res3.Items) != 2 {
		t.Errorf("res3.Items = %d, want 2 (after Invalidate)", len(res3.Items))
	}

	// Plant third skill, invalidate all
	skill3Dir := filepath.Join(homeDir, ".agents", "skills", "skill-three")
	if err := os.MkdirAll(skill3Dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(skill3Dir, "SKILL.md"), []byte("---\nname: skill-three\ndescription: Skill three\n---\nBody"), 0o644); err != nil {
		t.Fatal(err)
	}

	svc.InvalidateAll()
	res4, err := svc.List(ctx, homeDir, projDir)
	if err != nil {
		t.Fatalf("fourth list: %v", err)
	}
	if len(res4.Items) != 3 {
		t.Errorf("res4.Items = %d, want 3 (after InvalidateAll)", len(res4.Items))
	}
}

