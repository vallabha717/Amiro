// Package skills exposes HTTP handlers for listing and retrieving Agent Skills.
package skills

import (
	"context"
	"errors"

	"amiro/backend/internal/skills"
)

// Service defines the narrow interface the HTTP handler needs from internal/skills.
type Service interface {
	List(ctx context.Context, home, project string) (*skills.ListResult, error)
	Get(ctx context.Context, home, project, name string) (*skills.Skill, error)
	Create(ctx context.Context, home string, in skills.WriteInput) (*skills.Skill, []skills.FieldError, error)
	Update(ctx context.Context, home, name string, in skills.WriteInput) (*skills.Skill, []skills.FieldError, error)
	Delete(ctx context.Context, home, name string, force bool) error
	Duplicate(ctx context.Context, home, name, project string) (*skills.Skill, error)
}

// errNoEngine is returned by Generate when the handler was wired without an
// Engine -- the untagged sidecar build still registers this route (nothing
// in router.go guards it behind h.Engine != nil the way some routes guard
// behind an optional dependency), so a nil engine must fail cleanly rather
// than nil-pointer panic.
var errNoEngine = errors.New("skills: generation engine not configured")

// Handler serves Agent Skills read and authoring endpoints.
type Handler struct {
	service Service
	engine  Engine
}

// NewHandler constructs a skills HTTP handler. engine may be nil in tests
// that never call Generate.
func NewHandler(service Service, engine Engine) *Handler {
	return &Handler{service: service, engine: engine}
}

type ShadowedSkillDTO struct {
	Name     string `json:"name"`
	Scope    string `json:"scope"`
	Source   string `json:"source"`
	Path     string `json:"path"`
	RealPath string `json:"realPath,omitempty"`
	Reason   string `json:"reason"`
}

type DiagnosticDTO struct {
	Path     string `json:"path"`
	Skill    string `json:"skill,omitempty"`
	Severity string `json:"severity"`
	Message  string `json:"message"`
}

// SkillSummaryDTO is the Tier-1 catalog item returned in list responses (GET /api/skills).
// It deliberately omits Body and Resources to maintain a lightweight prompt/palette payload.
type SkillSummaryDTO struct {
	Name                   string             `json:"name"`
	Description            string             `json:"description"`
	Scope                  string             `json:"scope"`
	Source                 string             `json:"source"`
	Path                   string             `json:"path"`
	RealPath               string             `json:"realPath,omitempty"`
	Writable               bool               `json:"writable"`
	DisableModelInvocation bool               `json:"disableModelInvocation,omitempty"`
	License                string             `json:"license,omitempty"`
	Compatibility          string             `json:"compatibility,omitempty"`
	Metadata               map[string]string  `json:"metadata,omitempty"`
	AllowedTools           []string           `json:"allowedTools,omitempty"`
	Shadows                []ShadowedSkillDTO `json:"shadows,omitempty"`
}

// SkillDTO is the full Tier-2/Tier-3 skill item returned on direct retrieval (GET /api/skills/items/{name}).
type SkillDTO struct {
	Name                   string             `json:"name"`
	Description            string             `json:"description"`
	Scope                  string             `json:"scope"`
	Source                 string             `json:"source"`
	Path                   string             `json:"path"`
	RealPath               string             `json:"realPath,omitempty"`
	Writable               bool               `json:"writable"`
	DisableModelInvocation bool               `json:"disableModelInvocation,omitempty"`
	License                string             `json:"license,omitempty"`
	Compatibility          string             `json:"compatibility,omitempty"`
	Metadata               map[string]string  `json:"metadata,omitempty"`
	AllowedTools           []string           `json:"allowedTools,omitempty"`
	Resources              []string           `json:"resources,omitempty"`
	Body                   string             `json:"body"`
	Shadows                []ShadowedSkillDTO `json:"shadows,omitempty"`
}

type ListResponse struct {
	Items       []SkillSummaryDTO `json:"items"`
	Diagnostics []DiagnosticDTO   `json:"diagnostics"`
	Truncated   bool              `json:"truncated"`
}

// WriteRequest is the create / update body.
type WriteRequest struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	Body        string         `json:"body"`
	Frontmatter map[string]any `json:"frontmatter,omitempty"`
}

// FieldErrorDTO is a field-scoped error for the API response.
type FieldErrorDTO struct {
	Field   string `json:"field"`
	Message string `json:"message"`
}

// WriteResponse is returned on successful create / update / duplicate.
type WriteResponse struct {
	Skill    SkillDTO        `json:"skill"`
	Warnings []FieldErrorDTO `json:"warnings,omitempty"`
}

// ValidationErrorResponse is returned on 400 when input fails validation.
type ValidationErrorResponse struct {
	Errors   []FieldErrorDTO `json:"errors"`
	Warnings []FieldErrorDTO `json:"warnings,omitempty"`
}

func toFieldErrorDTOs(errs []skills.FieldError) []FieldErrorDTO {
	if len(errs) == 0 {
		return nil
	}
	out := make([]FieldErrorDTO, len(errs))
	for i, e := range errs {
		out[i] = FieldErrorDTO{Field: e.Field, Message: e.Message}
	}
	return out
}

func toShadowDTOs(shadows []skills.ShadowedSkill) []ShadowedSkillDTO {
	var out []ShadowedSkillDTO
	for _, sh := range shadows {
		out = append(out, ShadowedSkillDTO{
			Name:     sh.Name,
			Scope:    string(sh.Scope),
			Source:   sh.Source,
			Path:     sh.Path,
			RealPath: sh.RealPath,
			Reason:   sh.Reason,
		})
	}
	return out
}

func toSkillSummaryDTO(s *skills.Skill) SkillSummaryDTO {
	if s == nil {
		return SkillSummaryDTO{}
	}
	return SkillSummaryDTO{
		Name:                   s.Name,
		Description:            s.Description,
		Scope:                  string(s.Scope),
		Source:                 s.Source,
		Path:                   s.Path,
		RealPath:               s.RealPath,
		Writable:               s.Writable,
		DisableModelInvocation: s.DisableModelInvocation,
		License:                s.License,
		Compatibility:          s.Compatibility,
		Metadata:               s.Metadata,
		AllowedTools:           s.AllowedTools,
		Shadows:                toShadowDTOs(s.Shadows),
	}
}

func toSkillDTO(s *skills.Skill) SkillDTO {
	if s == nil {
		return SkillDTO{}
	}
	return SkillDTO{
		Name:                   s.Name,
		Description:            s.Description,
		Scope:                  string(s.Scope),
		Source:                 s.Source,
		Path:                   s.Path,
		RealPath:               s.RealPath,
		Writable:               s.Writable,
		DisableModelInvocation: s.DisableModelInvocation,
		License:                s.License,
		Compatibility:          s.Compatibility,
		Metadata:               s.Metadata,
		AllowedTools:           s.AllowedTools,
		Resources:              s.Resources,
		Body:                   s.Body,
		Shadows:                toShadowDTOs(s.Shadows),
	}
}

func toListResponse(res *skills.ListResult) ListResponse {
	if res == nil {
		return ListResponse{
			Items:       []SkillSummaryDTO{},
			Diagnostics: []DiagnosticDTO{},
			Truncated:   false,
		}
	}
	// Both start as non-nil empty slices, never `var ... []T` -- a nil
	// slice serializes as JSON `null`, and every consumer of this
	// response (the web dashboard's Skills page and its `useMutateSkills`
	// cache updater, the TUI's palette, this suite's own assertions)
	// treats `items`/`diagnostics` as always-iterable arrays. A `null`
	// list.items sent a `Cannot read properties of null` crash straight
	// through the web UI on the very first empty-state render.
	items := []SkillSummaryDTO{}
	for i := range res.Items {
		items = append(items, toSkillSummaryDTO(&res.Items[i]))
	}
	diags := []DiagnosticDTO{}
	for _, d := range res.Diagnostics {
		diags = append(diags, DiagnosticDTO{
			Path:     d.Path,
			Skill:    d.Skill,
			Severity: d.Severity,
			Message:  d.Message,
		})
	}
	return ListResponse{
		Items:       items,
		Diagnostics: diags,
		Truncated:   res.Truncated,
	}
}
