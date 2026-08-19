package apiclient

import (
	"context"
	"encoding/json"
	"time"
)

// Agent is a saved assistant persona.
type Agent struct {
	ID           string          `json:"id"`
	Name         string          `json:"name"`
	Description  *string         `json:"description,omitempty"`
	Icon         json.RawMessage `json:"icon,omitempty"`
	UserID       string          `json:"userId"`
	Instructions json.RawMessage `json:"instructions,omitempty"`
	Visibility   string          `json:"visibility"`
	CreatedAt    time.Time       `json:"createdAt"`
	UpdatedAt    time.Time       `json:"updatedAt"`
}

// AgentInput is the create/update body.
type AgentInput struct {
	Name         string          `json:"name"`
	Description  *string         `json:"description,omitempty"`
	Icon         json.RawMessage `json:"icon,omitempty"`
	Instructions json.RawMessage `json:"instructions,omitempty"`
	Visibility   string          `json:"visibility,omitempty"`
}

func (c *Client) ListAgents(ctx context.Context) ([]Agent, error) {
	var out []Agent
	err := c.Get(ctx, "/api/agent", &out)
	return out, err
}

func (c *Client) CreateAgent(ctx context.Context, in AgentInput) (Agent, error) {
	var out Agent
	err := c.Post(ctx, "/api/agent", in, &out)
	return out, err
}

func (c *Client) GetAgent(ctx context.Context, id string) (Agent, error) {
	var out Agent
	err := c.Get(ctx, join("/api/agent", id), &out)
	return out, err
}

func (c *Client) UpdateAgent(ctx context.Context, id string, in AgentInput) (Agent, error) {
	var out Agent
	err := c.Put(ctx, join("/api/agent", id), in, &out)
	return out, err
}

func (c *Client) DeleteAgent(ctx context.Context, id string) error {
	return c.Delete(ctx, join("/api/agent", id), nil)
}

// GenerateAgent is POST /api/agent/ai -- the "write me an agent" route. It
// calls a provider, so tests using it are cassette-backed or fake-mode.
func (c *Client) GenerateAgent(ctx context.Context, body any) (json.RawMessage, error) {
	var out json.RawMessage
	err := c.Post(ctx, "/api/agent/ai", body, &out)
	return out, err
}
