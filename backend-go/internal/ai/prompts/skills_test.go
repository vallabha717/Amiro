package prompts_test

import (
	"fmt"
	"strings"
	"testing"

	"amiro/backend/internal/ai/prompts"
	"amiro/backend/internal/skills"
)

func TestBuildSkillCatalogPrompt_EmptyListReturnsEmptyString(t *testing.T) {
	if got := prompts.BuildSkillCatalogPrompt(nil); got != "" {
		t.Fatalf("expected empty string, got %q", got)
	}
	if got := prompts.BuildSkillCatalogPrompt([]skills.Skill{}); got != "" {
		t.Fatalf("expected empty string, got %q", got)
	}
}

func TestBuildSkillCatalogPrompt_AllDisabledModelInvocationReturnsEmptyString(t *testing.T) {
	items := []skills.Skill{
		{Name: "disabled-1", Description: "Desc 1", DisableModelInvocation: true, Path: "/tmp/skills/disabled-1"},
		{Name: "disabled-2", Description: "Desc 2", DisableModelInvocation: true, Path: "/tmp/skills/disabled-2"},
	}
	if got := prompts.BuildSkillCatalogPrompt(items); got != "" {
		t.Fatalf("expected empty string when all skills have DisableModelInvocation=true, got %q", got)
	}
}

func TestBuildSkillCatalogPrompt_RendersAvailableSkillsAndFiltersDisabled(t *testing.T) {
	items := []skills.Skill{
		{
			Name:                   "code-review",
			Description:            "Reviews a diff for correctness and reuse.",
			Path:                   "/home/u/.agents/skills/code-review",
			DisableModelInvocation: false,
		},
		{
			Name:                   "secret-skill",
			Description:            "Only user-invocable.",
			Path:                   "/home/u/.agents/skills/secret-skill",
			DisableModelInvocation: true,
		},
	}

	got := prompts.BuildSkillCatalogPrompt(items)
	if !strings.Contains(got, "<available_skills>") || !strings.Contains(got, "</available_skills>") {
		t.Fatalf("missing <available_skills> XML tags in prompt:\n%s", got)
	}
	if !strings.Contains(got, "<name>code-review</name>") {
		t.Errorf("missing code-review in prompt:\n%s", got)
	}
	if !strings.Contains(got, "<description>Reviews a diff for correctness and reuse.</description>") {
		t.Errorf("missing code-review description in prompt:\n%s", got)
	}
	if !strings.Contains(got, "<location>/home/u/.agents/skills/code-review/SKILL.md</location>") {
		t.Errorf("missing code-review location in prompt:\n%s", got)
	}
	if strings.Contains(got, "secret-skill") {
		t.Errorf("secret-skill with DisableModelInvocation=true must be excluded from catalog:\n%s", got)
	}
	if !strings.Contains(got, "call the `skill` tool with its name") {
		t.Errorf("missing instruction block in prompt:\n%s", got)
	}
}

func TestBuildSkillCatalogPrompt_TruncatesDescriptionAndCapsCatalog(t *testing.T) {
	longDesc := strings.Repeat("x", 2000)
	var items []skills.Skill
	for i := 0; i < 300; i++ {
		items = append(items, skills.Skill{
			Name:        fmt.Sprintf("skill-%03d", i),
			Description: longDesc,
			Path:        fmt.Sprintf("/skills/skill-%03d", i),
		})
	}

	got := prompts.BuildSkillCatalogPrompt(items)
	if !strings.Contains(got, "skill-000") {
		t.Errorf("expected skill-000 to be present")
	}
	if !strings.Contains(got, "skill-255") {
		t.Errorf("expected skill-255 to be present")
	}
	if strings.Contains(got, "skill-256") {
		t.Errorf("catalog should cap at 256 skills, found skill-256")
	}

	// Check description truncation
	if strings.Contains(got, strings.Repeat("x", 1025)) {
		t.Errorf("description should be truncated at 1024 characters")
	}
	if !strings.Contains(got, strings.Repeat("x", 1024)) {
		t.Errorf("expected 1024 characters description to be present")
	}
}

func TestBuildSkillCatalogPrompt_RuneBoundaryTruncation(t *testing.T) {
	// A 3-byte rune repeated 1025 times
	descWithRunes := strings.Repeat("日", 1025)
	items := []skills.Skill{
		{Name: "japanese-skill", Description: descWithRunes, Path: "/skills/jp"},
	}

	got, report := prompts.BuildSkillCatalogPromptWithReport(items)
	if report.SkillsTruncated || report.TruncatedDescriptionCount != 1 {
		t.Errorf("expected report to identify description truncation, got %+v", report)
	}

	// Must be exactly 1024 runes long, perfectly valid UTF-8
	wantDesc := strings.Repeat("日", 1024)
	if !strings.Contains(got, "<description>"+wantDesc+"</description>") {
		t.Errorf("expected description to truncate on rune boundary without splitting multi-byte runes")
	}
}
