package apiclient

import (
	"context"
	"encoding/json"
	"time"
)

// MCPServer is one configured MCP server.
//
// Config is left raw: mcp.ServerConfig is a union over stdio and remote
// transports, and modelling it here would fix a shape the app is still free
// to extend. Tests assert on the fields they care about by decoding Config
// themselves.
type MCPServer struct {
	ID         string          `json:"id"`
	Name       string          `json:"name"`
	Config     json.RawMessage `json:"config"`
	Visibility string          `json:"visibility,omitempty"`
}

// MCPServerInput is the create/update body for POST /api/mcp.
type MCPServerInput struct {
	ID         string `json:"id,omitempty"`
	Name       string `json:"name"`
	Config     any    `json:"config"`
	Visibility string `json:"visibility,omitempty"`
}

// StdioConfig is the fixture server's transport: a command Amiro spawns and
// speaks MCP to over stdin/stdout.
type StdioConfig struct {
	Command string            `json:"command"`
	Args    []string          `json:"args,omitempty"`
	Env     map[string]string `json:"env,omitempty"`
}

func (c *Client) ListMCPServers(ctx context.Context) (json.RawMessage, error) {
	var out json.RawMessage
	err := c.Get(ctx, "/api/mcp/list", &out)
	return out, err
}

func (c *Client) SaveMCPServer(ctx context.Context, in MCPServerInput) (MCPServer, error) {
	var out MCPServer
	err := c.Post(ctx, "/api/mcp", in, &out)
	return out, err
}

func (c *Client) GetMCPServer(ctx context.Context, id string) (MCPServer, error) {
	var out MCPServer
	err := c.Get(ctx, join("/api/mcp/servers", id), &out)
	return out, err
}

func (c *Client) DeleteMCPServer(ctx context.Context, id string) error {
	return c.Delete(ctx, join("/api/mcp/servers", id), nil)
}

func (c *Client) RefreshMCPServer(ctx context.Context, id string) (json.RawMessage, error) {
	var out json.RawMessage
	err := c.Post(ctx, join("/api/mcp/servers", id)+"/refresh", nil, &out)
	return out, err
}

// CallMCPTool invokes one tool directly, bypassing the agent loop. This is
// what makes the MCP fixture server testable without spending a turn.
func (c *Client) CallMCPTool(ctx context.Context, serverID, tool string, input any) (json.RawMessage, error) {
	var out json.RawMessage
	err := c.Post(ctx, join("/api/mcp/servers", serverID, "tools", tool)+"/call", input, &out)
	return out, err
}

func (c *Client) ShareMCPServer(ctx context.Context, id string, body any) error {
	return c.Post(ctx, join("/api/mcp/servers", id)+"/share", body, nil)
}

func (c *Client) AuthorizeMCPServer(ctx context.Context, id string) error {
	return c.Post(ctx, join("/api/mcp/servers", id)+"/oauth/authorize", nil, nil)
}

// MCPCustomization is a per-server or per-tool prompt override.
type MCPCustomization struct {
	ID          string    `json:"id"`
	UserID      string    `json:"userId"`
	McpServerID string    `json:"mcpServerId"`
	Prompt      *string   `json:"prompt,omitempty"`
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

func (c *Client) ServerCustomization(ctx context.Context, server string) (MCPCustomization, error) {
	var out MCPCustomization
	err := c.Get(ctx, join("/api/mcp/server-customizations", server), &out)
	return out, err
}

func (c *Client) SetServerCustomization(ctx context.Context, server string, prompt *string) (MCPCustomization, error) {
	var out MCPCustomization
	err := c.Post(ctx, join("/api/mcp/server-customizations", server), map[string]any{"prompt": prompt}, &out)
	return out, err
}

func (c *Client) DeleteServerCustomization(ctx context.Context, server string) error {
	return c.Delete(ctx, join("/api/mcp/server-customizations", server), nil)
}

func (c *Client) ToolCustomizations(ctx context.Context, server string) (json.RawMessage, error) {
	var out json.RawMessage
	err := c.Get(ctx, join("/api/mcp/tool-customizations", server), &out)
	return out, err
}

func (c *Client) SetToolCustomization(ctx context.Context, server, tool string, prompt *string) (json.RawMessage, error) {
	var out json.RawMessage
	err := c.Post(ctx, join("/api/mcp/tool-customizations", server, tool), map[string]any{"prompt": prompt}, &out)
	return out, err
}

func (c *Client) DeleteToolCustomization(ctx context.Context, server, tool string) error {
	return c.Delete(ctx, join("/api/mcp/tool-customizations", server, tool), nil)
}


