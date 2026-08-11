// Package mcp ports src/lib/ai/mcp/**: the MCP server manager (config
// storage + live client lifecycle), server/tool customizations, and
// (oauth_flow.go, over internal/mcp/oauth) OAuth-authenticated remote
// servers. Bifrost's embedded MCP client (internal/ai/bifrost's MCP
// methods) replaces the raw @modelcontextprotocol/sdk transport handling
// create-mcp-client.ts used to hand-roll; this package is the "own code,
// not SDK" layer plan section 4's MCP row calls out -- config persistence,
// the connect/reconnect/remove lifecycle, per-user customizations, and now
// the OAuth discovery/DCR/PKCE dance too.
package mcp

import (
	"encoding/json"
	"errors"
)

// StdioConfig ports MCPStdioConfig (types/mcp.ts:13).
type StdioConfig struct {
	Command string            `json:"command"`
	Args    []string          `json:"args,omitempty"`
	Env     map[string]string `json:"env,omitempty"`
}

// RemoteConfig ports MCPRemoteConfig (types/mcp.ts:8). Headers are static,
// admin-supplied values -- there is no auth_type discriminant on the wire,
// matching the TS schema exactly. OAuth is auto-detected at connect time
// (oauth_flow.go's beginOAuthFlow), same as better-chatbot's own 401-
// triggered flow -- never configured here up front.
type RemoteConfig struct {
	URL     string            `json:"url"`
	Headers map[string]string `json:"headers,omitempty"`
}

// ServerConfig ports the MCPServerConfig union (types/mcp.ts:29). It is
// duck-typed on the wire -- "command" present means stdio, "url" present
// means remote -- exactly like is-mcp-config.ts's isMaybeStdioConfig /
// isMaybeRemoteConfig, rather than a discriminated union with an explicit
// type tag, so request/response JSON stays byte-compatible with the
// existing TS shape for Phase 7's eventual frontend rewire.
type ServerConfig struct {
	Stdio  *StdioConfig
	Remote *RemoteConfig
}

var ErrInvalidServerConfig = errors.New("mcp: config must have either \"command\" (stdio) or \"url\" (remote)")

func (c ServerConfig) MarshalJSON() ([]byte, error) {
	if c.Stdio != nil {
		return json.Marshal(c.Stdio)
	}
	if c.Remote != nil {
		return json.Marshal(c.Remote)
	}
	return nil, ErrInvalidServerConfig
}

func (c *ServerConfig) UnmarshalJSON(data []byte) error {
	var probe struct {
		Command *string `json:"command"`
		URL     *string `json:"url"`
	}
	if err := json.Unmarshal(data, &probe); err != nil {
		return err
	}
	switch {
	case probe.Command != nil:
		var s StdioConfig
		if err := json.Unmarshal(data, &s); err != nil {
			return err
		}
		c.Stdio = &s
		c.Remote = nil
	case probe.URL != nil:
		var r RemoteConfig
		if err := json.Unmarshal(data, &r); err != nil {
			return err
		}
		c.Remote = &r
		c.Stdio = nil
	default:
		return ErrInvalidServerConfig
	}
	return nil
}
