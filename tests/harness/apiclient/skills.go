package apiclient

import (
	"context"
	"net/url"
)

type SkillScope string

const (
	SkillScopeProject SkillScope = "project"
	SkillScopeUser    SkillScope = "user"
)

type ShadowedSkill struct {
	Name     string     `json:"name"`
	Scope    SkillScope `json:"scope"`
	Source   string     `json:"source"`
	Path     string     `json:"path"`
	RealPath string     `json:"realPath,omitempty"`
	Reason   string     `json:"reason"`
}

type SkillDiagnostic struct {
	Path     string `json:"path"`
	Skill    string `json:"skill,omitempty"`
	Severity string `json:"severity"`
	Message  string `json:"message"`
}

type SkillSummary struct {
	Name                   string            `json:"name"`
	Description            string            `json:"description"`
	Scope                  SkillScope        `json:"scope"`
	Source                 string            `json:"source"`
	Path                   string            `json:"path"`
	RealPath               string            `json:"realPath,omitempty"`
	Writable               bool              `json:"writable"`
	DisableModelInvocation bool              `json:"disableModelInvocation,omitempty"`
	License                string            `json:"license,omitempty"`
	Compatibility          string            `json:"compatibility,omitempty"`
	Metadata               map[string]string `json:"metadata,omitempty"`
	AllowedTools           []string          `json:"allowedTools,omitempty"`
	Shadows                []ShadowedSkill   `json:"shadows,omitempty"`
}

type Skill struct {
	Name                   string            `json:"name"`
	Description            string            `json:"description"`
	Scope                  SkillScope        `json:"scope"`
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
	Body                   string            `json:"body"`
	Shadows                []ShadowedSkill   `json:"shadows,omitempty"`
}

type SkillsListResponse struct {
	Items       []SkillSummary    `json:"items"`
	Diagnostics []SkillDiagnostic `json:"diagnostics"`
	Truncated   bool              `json:"truncated"`
}

func (c *Client) ListSkills(ctx context.Context, project ...string) (SkillsListResponse, error) {
	var out SkillsListResponse
	reqPath := "/api/skills"
	if len(project) > 0 && project[0] != "" {
		reqPath += "?project=" + url.QueryEscape(project[0])
	}
	err := c.Get(ctx, reqPath, &out)
	return out, err
}

func (c *Client) GetSkill(ctx context.Context, name string, project ...string) (Skill, error) {
	var out Skill
	reqPath := join("/api/skills/items", name)
	if len(project) > 0 && project[0] != "" {
		reqPath += "?project=" + url.QueryEscape(project[0])
	}
	err := c.Get(ctx, reqPath, &out)
	return out, err
}

// SkillWriteRequest is the create / update body.
type SkillWriteRequest struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	Body        string         `json:"body"`
	Frontmatter map[string]any `json:"frontmatter,omitempty"`
}

// SkillFieldError is a field-scoped validation error from the authoring API.
type SkillFieldError struct {
	Field   string `json:"field"`
	Message string `json:"message"`
}

// SkillWriteResponse is returned on successful create / update / duplicate.
type SkillWriteResponse struct {
	Skill    Skill             `json:"skill"`
	Warnings []SkillFieldError `json:"warnings,omitempty"`
}

// SkillValidationError is a non-200 response carrying field-level errors.
type SkillValidationError struct {
	Errors   []SkillFieldError `json:"errors"`
	Warnings []SkillFieldError `json:"warnings,omitempty"`
}

// CreateSkill calls POST /api/skills.
func (c *Client) CreateSkill(ctx context.Context, req SkillWriteRequest) (SkillWriteResponse, error) {
	var out SkillWriteResponse
	err := c.Post(ctx, "/api/skills", req, &out)
	return out, err
}

// UpdateSkill calls PUT /api/skills/items/{name}.
func (c *Client) UpdateSkill(ctx context.Context, name string, req SkillWriteRequest) (SkillWriteResponse, error) {
	var out SkillWriteResponse
	err := c.Put(ctx, join("/api/skills/items", name), req, &out)
	return out, err
}

// DeleteSkill calls DELETE /api/skills/items/{name}.
// Pass force=true to remove the skill even if it has unexpected files.
func (c *Client) DeleteSkill(ctx context.Context, name string, force bool) error {
	p := join("/api/skills/items", name)
	if force {
		p += "?force=true"
	}
	return c.Delete(ctx, p, nil)
}

// DuplicateSkill calls POST /api/skills/items/{name}/duplicate.
func (c *Client) DuplicateSkill(ctx context.Context, name string, project ...string) (SkillWriteResponse, error) {
	var out SkillWriteResponse
	reqPath := join("/api/skills/items", name) + "/duplicate"
	if len(project) > 0 && project[0] != "" {
		reqPath += "?project=" + url.QueryEscape(project[0])
	}
	err := c.Post(ctx, reqPath, nil, &out)
	return out, err
}

