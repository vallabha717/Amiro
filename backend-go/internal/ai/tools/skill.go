package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"sync"

	"amiro/backend/internal/skills"
)

const maxSkillResourcesListing = 32

type skillInput struct {
	Name string `json:"name"`
}

// ActivationSet tracks skills activated during a turn in a thread-safe manner.
type ActivationSet struct {
	mu     sync.Mutex
	active map[string]bool
}

// NewActivationSet constructs a thread-safe ActivationSet with optional initial active names.
func NewActivationSet(initial ...string) *ActivationSet {
	s := &ActivationSet{active: make(map[string]bool)}
	for _, name := range initial {
		norm := strings.ToLower(strings.TrimSpace(name))
		if norm != "" {
			s.active[norm] = true
		}
	}
	return s
}

// MarkActive returns true if the skill was ALREADY active, or registers it and returns false.
func (s *ActivationSet) MarkActive(name string) bool {
	if s == nil {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	norm := strings.ToLower(strings.TrimSpace(name))
	if s.active[norm] {
		return true
	}
	s.active[norm] = true
	return false
}

// IsActive reports whether a skill has already been activated in this turn.
func (s *ActivationSet) IsActive(name string) bool {
	if s == nil {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.active[strings.ToLower(strings.TrimSpace(name))]
}

// skillTool constructs the `skill(name)` tool definition. Returns false if no skills were discovered.
func skillTool(
	discovered []skills.Skill,
	onActivate func(s *skills.Skill),
	activated *ActivationSet,
) (Definition, bool) {
	if len(discovered) == 0 {
		return Definition{}, false
	}

	names := make([]string, 0, len(discovered))
	byName := make(map[string]skills.Skill, len(discovered))
	for _, s := range discovered {
		if s.DisableModelInvocation {
			continue
		}
		names = append(names, s.Name)
		byName[strings.ToLower(s.Name)] = s
	}
	if len(names) == 0 {
		return Definition{}, false
	}
	sort.Strings(names)

	namesJSON, _ := json.Marshal(names)
	paramSchema := fmt.Sprintf(`{
		"type": "object",
		"properties": {
			"name": {
				"type": "string",
				"enum": %s,
				"description": "The exact name of the skill to activate from the available skills catalog."
			}
		},
		"required": ["name"],
		"additionalProperties": false
	}`, string(namesJSON))

	return Definition{
		Name:             NameSkill,
		Toolkit:          ToolkitSkill,
		Risk:             RiskRead,
		Description:      "Load a skill's full instructions and bundled resources into context. Use when a task matches an available skill's description.",
		ParametersSchema: json.RawMessage(paramSchema),
		Execute: func(ctx context.Context, raw json.RawMessage) (any, error) {
			var in skillInput
			if err := json.Unmarshal(raw, &in); err != nil {
				return nil, fmt.Errorf("skill: %w", err)
			}
			norm := strings.ToLower(strings.TrimSpace(in.Name))
			if norm == "" {
				return nil, fmt.Errorf("skill: name is required")
			}

			s, ok := byName[norm]
			if !ok {
				return nil, fmt.Errorf("skill: %q is not a known skill", in.Name)
			}

			if activated != nil && activated.MarkActive(norm) {
				return fmt.Sprintf("Skill %q is already active in this turn.", s.Name), nil
			}

			if onActivate != nil {
				onActivate(&s)
			}

			return FormatSkillContent(s), nil
		},
	}, true
}

// FormatSkillContent renders a skill's instructions into the standard <skill_content> envelope.
func FormatSkillContent(s skills.Skill) string {
	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("<skill_content name=%q>\n", s.Name))
	body := strings.TrimSpace(s.Body)
	if body != "" {
		sb.WriteString(body)
		sb.WriteString("\n\n")
	}
	sb.WriteString(fmt.Sprintf("Skill directory: %s\n", s.Path))
	sb.WriteString("Relative paths in this skill resolve against that directory.\n")

	if len(s.Resources) > 0 {
		sb.WriteString("<skill_resources>\n")
		limit := len(s.Resources)
		truncated := false
		if limit > maxSkillResourcesListing {
			limit = maxSkillResourcesListing
			truncated = true
		}
		for i := 0; i < limit; i++ {
			sb.WriteString(fmt.Sprintf("  <file>%s</file>\n", s.Resources[i]))
		}
		if truncated {
			sb.WriteString(fmt.Sprintf("  <notice>showing first %d of %d resources</notice>\n", maxSkillResourcesListing, len(s.Resources)))
		}
		sb.WriteString("</skill_resources>\n")
	}

	sb.WriteString("</skill_content>")
	return sb.String()
}
