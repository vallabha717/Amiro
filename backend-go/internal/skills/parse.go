package skills

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"gopkg.in/yaml.v3"
)

// Skill is a fully parsed Agent Skill.
type Skill struct {
	Name                   string            `json:"name"`
	Description            string            `json:"description"`
	Scope                  Scope             `json:"scope"`
	Source                 string            `json:"source"`
	Path                   string            `json:"path"`
	RealPath               string            `json:"realPath,omitempty"`
	Writable               bool              `json:"writable"`
	DisableModelInvocation bool              `json:"disableModelInvocation,omitempty"`
	License                string            `json:"license,omitempty"`
	Compatibility          string            `json:"compatibility,omitempty"`
	Metadata               map[string]string `json:"metadata,omitempty"`
	AllowedTools           []string          `json:"allowedTools,omitempty"`
	Resources              []string          `json:"resources,omitempty"`
	Body                   string            `json:"body,omitempty"`
	Shadows                []ShadowedSkill   `json:"shadows,omitempty"`
}

// FrontmatterExtras converts the optional frontmatter fields into a map suitable for serialization.
func (s *Skill) FrontmatterExtras() map[string]any {
	extras := make(map[string]any)
	if s.License != "" {
		extras["license"] = s.License
	}
	if s.Compatibility != "" {
		extras["compatibility"] = s.Compatibility
	}
	if len(s.Metadata) > 0 {
		extras["metadata"] = s.Metadata
	}
	if len(s.AllowedTools) > 0 {
		extras["allowed-tools"] = s.AllowedTools
	}
	if s.DisableModelInvocation {
		extras["disable-model-invocation"] = s.DisableModelInvocation
	}
	return extras
}

// ShadowedSkill describes another skill discovered with the same name or path that was shadowed by precedence.
type ShadowedSkill struct {
	Name     string     `json:"name"`
	Scope    Scope      `json:"scope"`
	Source   string     `json:"source"`
	Path     string     `json:"path"`
	RealPath string     `json:"realPath"`
	Reason   string     `json:"reason"`
}

// Diagnostic represents a warning, error or info diagnostic encountered while scanning or parsing.
type Diagnostic struct {
	Path     string `json:"path"`
	Skill    string `json:"skill,omitempty"`
	Severity string `json:"severity"` // "warning", "error", "info"
	Message  string `json:"message"`
}

var validNameRegex = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)

type rawFrontmatter struct {
	Name                   string            `yaml:"name"`
	Description            string            `yaml:"description"`
	License                string            `yaml:"license"`
	Compatibility          string            `yaml:"compatibility"`
	Metadata               map[string]string `yaml:"metadata"`
	AllowedTools           any               `yaml:"allowed-tools"`
	DisableModelInvocation any               `yaml:"disable-model-invocation"`
}

// ParseSkill parses a skill from a directory containing SKILL.md.
func ParseSkill(dirPath, realPath string, root SourceRoot, maxSize int64) (*Skill, []Diagnostic, error) {
	skillMDPath := filepath.Join(dirPath, "SKILL.md")
	fi, err := os.Stat(skillMDPath)
	if err != nil {
		return nil, nil, fmt.Errorf("stat SKILL.md: %w", err)
	}

	if maxSize > 0 && fi.Size() > maxSize {
		diag := Diagnostic{
			Path:     skillMDPath,
			Severity: "error",
			Message:  fmt.Sprintf("SKILL.md exceeds size bound (%d bytes > %d max bytes)", fi.Size(), maxSize),
		}
		return nil, []Diagnostic{diag}, fmt.Errorf("SKILL.md too large")
	}

	content, err := os.ReadFile(skillMDPath)
	if err != nil {
		return nil, nil, fmt.Errorf("read SKILL.md: %w", err)
	}

	dirName := filepath.Base(dirPath)
	skill, diags, err := ParseSkillContent(content, skillMDPath, dirName)
	if err != nil {
		return nil, diags, err
	}

	skill.Scope = root.Scope
	skill.Source = root.Source
	skill.Path = dirPath
	skill.RealPath = realPath
	skill.Writable = root.Writable

	// Discover resources in the directory
	skill.Resources = discoverResources(dirPath)

	return skill, diags, nil
}

// ParseSkillContent parses raw SKILL.md bytes.
func ParseSkillContent(content []byte, path, dirName string) (*Skill, []Diagnostic, error) {
	var diags []Diagnostic

	fmBytes, bodyBytes, hasFM := splitFrontmatter(content)
	if !hasFM {
		diag := Diagnostic{
			Path:     path,
			Severity: "error",
			Message:  "SKILL.md is missing frontmatter --- fence",
		}
		return nil, []Diagnostic{diag}, fmt.Errorf("missing frontmatter")
	}

	var raw rawFrontmatter
	var genericMap map[string]any

	parseErr := yaml.Unmarshal(fmBytes, &raw)
	_ = yaml.Unmarshal(fmBytes, &genericMap)

	if parseErr != nil {
		// Retry by quoting unquoted scalar values that contain colons
		quotedFM := retryQuoteScalars(string(fmBytes))
		if retryErr := yaml.Unmarshal([]byte(quotedFM), &raw); retryErr != nil {
			diag := Diagnostic{
				Path:     path,
				Severity: "error",
				Message:  fmt.Sprintf("unparseable YAML frontmatter: %v", parseErr),
			}
			return nil, []Diagnostic{diag}, fmt.Errorf("unparseable YAML: %w", parseErr)
		}
		_ = yaml.Unmarshal([]byte(quotedFM), &genericMap)
	}

	desc := strings.TrimSpace(raw.Description)
	if desc == "" {
		diag := Diagnostic{
			Path:     path,
			Severity: "error",
			Message:  "missing or empty description in frontmatter",
		}
		return nil, []Diagnostic{diag}, fmt.Errorf("missing description")
	}

	var name string
	rawName := strings.TrimSpace(raw.Name)
	if rawName == "" {
		name = dirName
		diags = append(diags, Diagnostic{
			Path:     path,
			Skill:    name,
			Severity: "warning",
			Message:  fmt.Sprintf("missing name in frontmatter; using directory name %q", dirName),
		})
	} else {
		name = rawName
		if name != dirName {
			diags = append(diags, Diagnostic{
				Path:     path,
				Skill:    name,
				Severity: "warning",
				Message:  fmt.Sprintf("name %q disagrees with directory name %q; directory name is used for invocation", name, dirName),
			})
		}
	}

	// Validate name rules
	if len(name) > 64 {
		diags = append(diags, Diagnostic{
			Path:     path,
			Skill:    name,
			Severity: "warning",
			Message:  fmt.Sprintf("name %q exceeds 64 characters", name),
		})
	}
	if !validNameRegex.MatchString(name) {
		diags = append(diags, Diagnostic{
			Path:     path,
			Skill:    name,
			Severity: "warning",
			Message:  fmt.Sprintf("name %q contains non-standard characters or consecutive hyphens", name),
		})
	}

	metadata := make(map[string]string)
	if raw.Metadata != nil {
		for k, v := range raw.Metadata {
			metadata[k] = v
		}
	}
	// Copy unknown top-level keys into metadata
	standardKeys := map[string]bool{
		"name":                     true,
		"description":              true,
		"license":                  true,
		"compatibility":            true,
		"metadata":                 true,
		"allowed-tools":            true,
		"disable-model-invocation": true,
	}
	for k, v := range genericMap {
		if !standardKeys[k] {
			if strVal, ok := v.(string); ok {
				metadata[k] = strVal
			} else {
				metadata[k] = fmt.Sprintf("%v", v)
			}
		}
	}

	var allowedTools []string
	switch at := raw.AllowedTools.(type) {
	case string:
		for _, tool := range strings.Fields(at) {
			allowedTools = append(allowedTools, tool)
		}
	case []any:
		for _, item := range at {
			if s, ok := item.(string); ok {
				allowedTools = append(allowedTools, s)
			}
		}
	case []string:
		allowedTools = at
	}

	disableModelInvocation := false
	switch d := raw.DisableModelInvocation.(type) {
	case bool:
		disableModelInvocation = d
	case string:
		disableModelInvocation = strings.EqualFold(d, "true")
	}

	skill := &Skill{
		Name:                   name,
		Description:            desc,
		DisableModelInvocation: disableModelInvocation,
		License:                raw.License,
		Compatibility:          raw.Compatibility,
		Metadata:               metadata,
		AllowedTools:           allowedTools,
		Body:                   strings.TrimSpace(string(bodyBytes)),
	}

	return skill, diags, nil
}

func splitFrontmatter(content []byte) ([]byte, []byte, bool) {
	trimmed := bytes.TrimLeft(content, " \t\r\n")
	if !bytes.HasPrefix(trimmed, []byte("---")) {
		return nil, nil, false
	}

	rest := trimmed[3:]
	// Skip the remainder of the first --- line (e.g. newline)
	idx := bytes.IndexByte(rest, '\n')
	if idx == -1 {
		return nil, nil, false
	}
	rest = rest[idx+1:]

	// Find the closing --- fence
	lines := bytes.Split(rest, []byte("\n"))
	var fmEndIdx = -1
	var byteCount int
	for i, line := range lines {
		trimmedLine := bytes.TrimSpace(line)
		if bytes.Equal(trimmedLine, []byte("---")) {
			fmEndIdx = i
			break
		}
		byteCount += len(line) + 1 // +1 for newline
	}

	if fmEndIdx == -1 {
		return nil, nil, false
	}

	fm := rest[:byteCount]
	bodyStart := byteCount + len(lines[fmEndIdx]) + 1
	if bodyStart > len(rest) {
		bodyStart = len(rest)
	}
	body := rest[bodyStart:]

	return fm, body, true
}

func retryQuoteScalars(fm string) string {
	lines := strings.Split(fm, "\n")
	var result []string
	topLevelScalarRegex := regexp.MustCompile(`^([a-zA-Z0-9_-]+):\s*(.+)$`)

	for _, line := range lines {
		if strings.HasPrefix(line, " ") || strings.HasPrefix(line, "\t") {
			result = append(result, line)
			continue
		}
		matches := topLevelScalarRegex.FindStringSubmatch(line)
		if len(matches) == 3 {
			key := matches[1]
			val := strings.TrimSpace(matches[2])
			if !strings.HasPrefix(val, `"`) && !strings.HasPrefix(val, `'`) && !strings.HasPrefix(val, `[`) && !strings.HasPrefix(val, `{`) && !strings.HasPrefix(val, `|`) && !strings.HasPrefix(val, `>`) {
				escaped := strings.ReplaceAll(val, `"`, `\"`)
				line = fmt.Sprintf(`%s: "%s"`, key, escaped)
			}
		}
		result = append(result, line)
	}
	return strings.Join(result, "\n")
}

func discoverResources(dirPath string) []string {
	var resources []string
	entries, err := os.ReadDir(dirPath)
	if err != nil {
		return nil
	}
	for _, entry := range entries {
		name := entry.Name()
		if name == "SKILL.md" || strings.HasPrefix(name, ".") {
			continue
		}
		if entry.IsDir() {
			// Walk subdirectory up to 2 levels deep
			subEntries, err := os.ReadDir(filepath.Join(dirPath, name))
			if err == nil {
				for _, sub := range subEntries {
					subName := sub.Name()
					if strings.HasPrefix(subName, ".") {
						continue
					}
					resources = append(resources, filepath.Join(name, subName))
				}
			}
		} else {
			resources = append(resources, name)
		}
	}
	return resources
}
