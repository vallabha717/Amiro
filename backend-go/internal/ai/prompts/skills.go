package prompts

import (
	"fmt"
	"path/filepath"
	"strings"

	"amiro/backend/internal/skills"
)

const (
	MaxSkillDescriptionLen = 1024
	MaxSkillCatalogEntries = 256
)

// SkillCatalogReport details any truncations applied while building the catalog prompt.
type SkillCatalogReport struct {
	TotalInvocableCount       int
	IncludedCount             int
	SkillsTruncated           bool
	TruncatedDescriptionCount int
	TruncatedSkillNames       []string
}

// BuildSkillCatalogPrompt constructs the <available_skills> system prompt block
// for Tier 1 discovery disclosure. Skills with DisableModelInvocation set to true
// are excluded here and only here. Returns an empty string if no invocable skills exist.
func BuildSkillCatalogPrompt(items []skills.Skill) string {
	prompt, _ := BuildSkillCatalogPromptWithReport(items)
	return prompt
}

// BuildSkillCatalogPromptWithReport constructs the catalog prompt and reports whether
// any skill list limit (256) or rune-length description limits (1024) were applied.
func BuildSkillCatalogPromptWithReport(items []skills.Skill) (string, SkillCatalogReport) {
	var report SkillCatalogReport

	var active []skills.Skill
	for _, s := range items {
		if s.DisableModelInvocation {
			continue
		}
		active = append(active, s)
	}

	report.TotalInvocableCount = len(active)
	if len(active) == 0 {
		return "", report
	}

	if len(active) > MaxSkillCatalogEntries {
		report.SkillsTruncated = true
		active = active[:MaxSkillCatalogEntries]
	}
	report.IncludedCount = len(active)

	var sb strings.Builder
	sb.WriteString("<available_skills>\n")
	for _, s := range active {
		desc, truncated := truncateRunes(s.Description, MaxSkillDescriptionLen)
		if truncated {
			report.TruncatedDescriptionCount++
			report.TruncatedSkillNames = append(report.TruncatedSkillNames, s.Name)
		}
		loc := s.Path
		if !strings.HasSuffix(loc, "SKILL.md") {
			loc = filepath.Join(loc, "SKILL.md")
		}
		sb.WriteString("  <skill>\n")
		sb.WriteString(fmt.Sprintf("    <name>%s</name>\n", s.Name))
		sb.WriteString(fmt.Sprintf("    <description>%s</description>\n", desc))
		sb.WriteString(fmt.Sprintf("    <location>%s</location>\n", loc))
		sb.WriteString("  </skill>\n")
	}
	sb.WriteString("</available_skills>\n\n")
	sb.WriteString("When a task matches a skill's description, call the `skill` tool with its name to load the full instructions and bundled resources before acting.")

	return sb.String(), report
}

func truncateRunes(s string, maxRunes int) (string, bool) {
	runes := []rune(s)
	if len(runes) > maxRunes {
		return string(runes[:maxRunes]), true
	}
	return s, false
}
