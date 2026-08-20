package skills

import (
	"fmt"
	"sort"
	"strings"
)

// ListResult is the final output of discovering and resolving skills.
type ListResult struct {
	Items       []Skill      `json:"items"`
	Diagnostics []Diagnostic `json:"diagnostics"`
	Truncated   bool         `json:"truncated"`
}

// Resolve resolves collisions, dedupes, and enforces precedence over scanned skills.
func Resolve(scanned ScanResult, maxSkills int) ListResult {
	if maxSkills <= 0 {
		maxSkills = DefaultMaxSkills
	}

	result := ListResult{
		Diagnostics: scanned.Diagnostics,
		Truncated:   scanned.Truncated,
	}

	// First, sort scanned skills by precedence:
	// Lower SourceIndex wins (Sources is already sorted: project (.agents > .amiro > .claude > .codex) > user (.agents > .amiro > .claude > .codex)).
	// Ties broken by path.
	sort.SliceStable(scanned.Skills, func(i, j int) bool {
		if scanned.Skills[i].SourceIndex != scanned.Skills[j].SourceIndex {
			return scanned.Skills[i].SourceIndex < scanned.Skills[j].SourceIndex
		}
		return scanned.Skills[i].Skill.Path < scanned.Skills[j].Skill.Path
	})

	// 1. Dedup by identity (real path)
	// If the exact same real directory was discovered multiple times (e.g. symlink),
	// the highest precedence encounter wins, and duplicates are dropped.
	seenRealPaths := make(map[string]bool)
	var identityDeduped []ScannedSkill
	for _, item := range scanned.Skills {
		realP := item.Skill.RealPath
		if realP == "" {
			realP = item.Skill.Path
		}
		if seenRealPaths[realP] {
			continue
		}
		seenRealPaths[realP] = true
		identityDeduped = append(identityDeduped, item)
	}

	// 2. Dedup by normalized name and track shadowing
	type winnerEntry struct {
		skill *Skill
		index int
	}
	winnersByName := make(map[string]*winnerEntry)
	var winnerKeys []string

	for _, item := range identityDeduped {
		normName := strings.ToLower(strings.TrimSpace(item.Skill.Name))
		if existing, exists := winnersByName[normName]; exists {
			// Existing winner outranks this item because identityDeduped is sorted by precedence.
			existing.skill.Shadows = append(existing.skill.Shadows, ShadowedSkill{
				Name:     item.Skill.Name,
				Scope:    item.Skill.Scope,
				Source:   item.Skill.Source,
				Path:     item.Skill.Path,
				RealPath: item.Skill.RealPath,
				Reason:   fmt.Sprintf("shadowed by %s skill (%s) in %s", existing.skill.Scope, existing.skill.Source, existing.skill.Path),
			})
		} else {
			winnersByName[normName] = &winnerEntry{
				skill: item.Skill,
				index: item.SourceIndex,
			}
			winnerKeys = append(winnerKeys, normName)
		}
	}

	// Sort final items deterministically by normalized name
	sort.Strings(winnerKeys)

	for _, key := range winnerKeys {
		w := winnersByName[key]
		result.Items = append(result.Items, *w.skill)
	}

	// Enforce max skills limit
	if len(result.Items) > maxSkills {
		result.Truncated = true
		result.Diagnostics = append(result.Diagnostics, Diagnostic{
			Severity: "warning",
			Message:  fmt.Sprintf("max skills bound reached (%d skills found, capped at %d)", len(result.Items), maxSkills),
		})
		result.Items = result.Items[:maxSkills]
	}

	return result
}
