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
