package apiclient

import (
	"context"
	"encoding/json"
)

// Workflow is a saved node graph.
type Workflow struct {
	ID          string          `json:"id"`
	Name        string          `json:"name"`
	Description *string         `json:"description,omitempty"`
	Icon        json.RawMessage `json:"icon,omitempty"`
	IsPublished *bool           `json:"isPublished,omitempty"`
	Visibility  *string         `json:"visibility,omitempty"`
}

// WorkflowInput is the create/update body.
type WorkflowInput struct {
	ID                  string          `json:"id,omitempty"`
	Name                string          `json:"name"`
	Description         *string         `json:"description,omitempty"`
	Icon                json.RawMessage `json:"icon,omitempty"`
	IsPublished         *bool           `json:"isPublished,omitempty"`
	Visibility          *string         `json:"visibility,omitempty"`
	NoGenerateInputNode bool            `json:"noGenerateInputNode,omitempty"`
}

// WorkflowStructure is the nodes and edges. Both are left raw: the node
// schema is the app's to evolve, and a transcribed copy here would break
// every workflow test on a change that added one optional field.
type WorkflowStructure struct {
	Nodes       json.RawMessage `json:"nodes"`
	Edges       json.RawMessage `json:"edges"`
	DeleteNodes []string        `json:"deleteNodes,omitempty"`
	DeleteEdges []string        `json:"deleteEdges,omitempty"`
}

func (c *Client) ListWorkflows(ctx context.Context) ([]Workflow, error) {
	var out []Workflow
	err := c.Get(ctx, "/api/workflow", &out)
	return out, err
}

func (c *Client) SaveWorkflow(ctx context.Context, in WorkflowInput) (Workflow, error) {
	var out Workflow
	err := c.Post(ctx, "/api/workflow", in, &out)
	return out, err
}

func (c *Client) GetWorkflow(ctx context.Context, id string) (Workflow, error) {
	var out Workflow
	err := c.Get(ctx, join("/api/workflow", id), &out)
	return out, err
}

func (c *Client) UpdateWorkflow(ctx context.Context, id string, in WorkflowInput) (Workflow, error) {
	var out Workflow
	err := c.Put(ctx, join("/api/workflow", id), in, &out)
	return out, err
}

func (c *Client) DeleteWorkflow(ctx context.Context, id string) error {
	return c.Delete(ctx, join("/api/workflow", id), nil)
}

func (c *Client) WorkflowStructure(ctx context.Context, id string) (WorkflowStructure, error) {
	var out WorkflowStructure
	err := c.Get(ctx, join("/api/workflow", id)+"/structure", &out)
	return out, err
}

func (c *Client) SaveWorkflowStructure(ctx context.Context, id string, in WorkflowStructure) (json.RawMessage, error) {
	var out json.RawMessage
	err := c.Post(ctx, join("/api/workflow", id)+"/structure", in, &out)
	return out, err
}

func (c *Client) ExecuteWorkflow(ctx context.Context, id string, body any) (json.RawMessage, error) {
	var out json.RawMessage
	err := c.Post(ctx, join("/api/workflow", id)+"/execute", body, &out)
	return out, err
}

func (c *Client) WorkflowTools(ctx context.Context) (json.RawMessage, error) {
	var out json.RawMessage
	err := c.Get(ctx, "/api/workflow/tools", &out)
	return out, err
}
