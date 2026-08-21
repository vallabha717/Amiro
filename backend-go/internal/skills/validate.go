package skills

import (
	"fmt"
	"strings"
	"unicode/utf8"
)

// FieldError represents a validation error tied to a specific input field.
type FieldError struct {
	Field   string `json:"field"`
	Message string `json:"message"`
}

// ValidationResult aggregates hard errors and soft warnings.
type ValidationResult struct {
	Errors   []FieldError `json:"errors,omitempty"`
	Warnings []FieldError `json:"warnings,omitempty"`
}

// ValidateName checks the skill name format.
// It reuses validNameRegex from parse.go (same package — no re-declaration).
func ValidateName(name string) ValidationResult {
	var res ValidationResult
	if name == "" {
		res.Errors = append(res.Errors, FieldError{Field: "name", Message: "name may not be empty"})
		return res
	}
	if len(name) > 64 {
		res.Errors = append(res.Errors, FieldError{Field: "name", Message: "name must be at most 64 characters"})
	}
	if !validNameRegex.MatchString(name) {
		res.Errors = append(res.Errors, FieldError{Field: "name", Message: "name must match /^[a-z0-9]+(-[a-z0-9]+)*$/"})
	}
	if strings.Contains(name, "claude") || strings.Contains(name, "anthropic") {
		res.Warnings = append(res.Warnings, FieldError{Field: "name", Message: "name contains vendor prefixes that may affect portability"})
	}
	return res
}

// ValidateDescription checks description length.
func ValidateDescription(desc string) ValidationResult {
	var res ValidationResult
	if desc == "" {
		res.Errors = append(res.Errors, FieldError{Field: "description", Message: "description may not be empty"})
	}
	if l := utf8.RuneCountInString(desc); l > 1024 {
		res.Errors = append(res.Errors, FieldError{Field: "description", Message: "description must be <= 1024 characters"})
	}
	return res
}

// allowedFrontmatterKeys enumerates the permitted keys in SKILL.md frontmatter.
var allowedFrontmatterKeys = map[string]bool{
	"name":                     true,
	"description":              true,
	"license":                  true,
	"compatibility":            true,
	"metadata":                 true,
	"allowed-tools":            true,
	"disable-model-invocation": true,
}

// ValidateFrontmatter rejects unknown keys with a field-scoped error naming the key.
func ValidateFrontmatter(fm map[string]any) ValidationResult {
	var res ValidationResult
	for k := range fm {
		if !allowedFrontmatterKeys[k] {
			res.Errors = append(res.Errors, FieldError{Field: "frontmatter", Message: fmt.Sprintf("unknown frontmatter key %q", k)})
		}
	}
	return res
}

// ValidateBody checks body size and line count.
func ValidateBody(body string) ValidationResult {
	var res ValidationResult
	if len(body) > 1<<20 { // >1MiB
		res.Errors = append(res.Errors, FieldError{Field: "body", Message: "skill body exceeds 1 MiB limit"})
	}
	if lines := strings.Count(body, "\n") + 1; lines > 500 {
		res.Warnings = append(res.Warnings, FieldError{Field: "body", Message: "skill body > 500 lines; consider splitting"})
	}
	return res
}

// CombineResults merges multiple ValidationResult values.
func CombineResults(results ...ValidationResult) ValidationResult {
	var out ValidationResult
	for _, r := range results {
		out.Errors = append(out.Errors, r.Errors...)
		out.Warnings = append(out.Warnings, r.Warnings...)
	}
	return out
}
