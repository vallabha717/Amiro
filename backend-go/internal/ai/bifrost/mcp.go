package bifrostai

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/maximhq/bifrost/core/schemas"
)

// MCPConnectionType is the subset of schemas.MCPConnectionType better-chatbot's
// own MCPServerConfig union actually needs (types/mcp.ts's MCPStdioConfig /
// MCPRemoteConfig) -- Bifrost supports more (SSE, in-process), not exposed here.
type MCPConnectionType string

const (
	MCPConnectionHTTP  MCPConnectionType = "http"
	MCPConnectionSTDIO MCPConnectionType = "stdio"
)

// MCPClientConfig is what internal/mcp (the manager/config-storage layer,
// "own code" per plan section 4's MCP row) passes to add/update a client --
// a plain DTO so that package never imports Bifrost's schemas directly,
// matching how Message/Chunk/ResolvedModel already keep the chat path's
// schemas usage confined to this package.
//
// Name is Bifrost's *internal* client identifier, not necessarily the
// user-facing server name: Bifrost requires client names to be ASCII with
// no hyphens or spaces (it uses "-" as the tool-name prefix separator
// internally), while better-chatbot's own server names are commonly
// hyphenated (its own validation regex is `^[a-zA-Z0-9\-]+$`). Callers
// sanitize before constructing this (internal/mcp does so, keeping the
// original hyphenated name in its own DB column and API responses --
// Bifrost's Name is purely an implementation detail of the live
// connection).
type MCPClientConfig struct {
	ID             string
	Name           string
	ConnectionType MCPConnectionType
	URL            string
	Headers        map[string]string
	Command        string
	Args           []string
	Env            map[string]string
}

// MCPToolInfo ports MCPToolInfo (types/mcp.ts:30), using the tool's true
// original name (not Bifrost's internal sanitized/prefixed form) so it
// matches what a caller would see calling the MCP server directly.
type MCPToolInfo struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	InputSchema json.RawMessage `json:"inputSchema,omitempty"`
}

// MCPClientStatus ports the "status" values MCPServerInfo.status
// (types/mcp.ts:47) can hold for a live connection -- "loading" (TS-only,
// covers the brief window a connect attempt is in flight) has no Bifrost
// equivalent exposed here and is never produced. Authorizing is set by
// internal/mcp itself (not Bifrost, which has no OAuth concept at this
// layer) when a remote server's connection needs the user to complete an
// OAuth flow -- see internal/mcp/oauth.
type MCPClientStatus string

const (
	MCPStatusConnected    MCPClientStatus = "connected"
	MCPStatusDisconnected MCPClientStatus = "disconnected"
	MCPStatusError        MCPClientStatus = "error"
	MCPStatusAuthorizing  MCPClientStatus = "authorizing"
)

// MCPClientState is one live client's current status and tools, as
// reported by Bifrost's MCP manager right now -- internal/mcp merges this
// with its own DB-persisted config list (mirrors mcp/list/route.ts's
// merge of mcpRepository rows with mcpClientsManager.getClients()).
type MCPClientState struct {
	ID     string
	Name   string
	Status MCPClientStatus
	Tools  []MCPToolInfo
}

// MCPToolCallResult ports the {isError, error, content} shape
// toolCall/callTool return in the TS manager (create-mcp-clients-manager.ts:345,
// create-mcp-client.ts:411).
type MCPToolCallResult struct {
	IsError bool
	Content string
	Error   string
}

// AddMCPClient registers and connects a new MCP client. Synchronous: it
// dials the server and returns an error if the connection fails (matching
// create-mcp-client.ts's MCPClient.connect() being awaited before
// persistClient resolves).
func (c *Client) AddMCPClient(ctx context.Context, cfg MCPClientConfig) error {
	bc, err := toBifrostMCPConfig(cfg)
	if err != nil {
		return err
	}
	return c.bf.AddMCPClient(ctx, bc)
}

// RemoveMCPClient disconnects and removes a client. Returns nil (not an
// error) when the client isn't currently connected -- callers may not know
// whether a prior AddMCPClient succeeded (e.g. it failed and Bifrost never
// retained the entry), and removal is idempotent from internal/mcp's point
// of view either way.
func (c *Client) RemoveMCPClient(id string) error {
	if err := c.bf.RemoveMCPClient(id); err != nil {
		if strings.Contains(err.Error(), "not found") {
			return nil
		}
		return err
	}
	return nil
}

// MCPClientStates returns every currently-connected (or errored) MCP
// client's live state. Empty if MCP has never been configured (no client
// added yet).
func (c *Client) MCPClientStates() []MCPClientState {
	if c.bf.MCPManager == nil {
		return nil
	}
	raw := c.bf.MCPManager.GetClients()
	out := make([]MCPClientState, 0, len(raw))
	for _, s := range raw {
		if s.ExecutionConfig == nil {
			continue
		}
		out = append(out, MCPClientState{
			ID:     s.ExecutionConfig.ID,
			Name:   s.ExecutionConfig.Name,
			Status: toMCPStatus(s.State),
			Tools:  toMCPToolInfo(s),
		})
	}
	return out
}

// CallMCPTool invokes one tool on a connected client by its true (not
// Bifrost-sanitized) name, returning the same {isError, content} shape
// regardless of whether the failure came from Bifrost, the transport, or
// the tool itself -- matching how the TS manager's toolCall/callTool never
// let a tool-call failure become an unhandled rejection.
func (c *Client) CallMCPTool(ctx context.Context, clientID, toolName string, args json.RawMessage) MCPToolCallResult {
	if c.bf.MCPManager == nil {
		return MCPToolCallResult{IsError: true, Error: "mcp: not configured"}
	}
	states := c.bf.MCPManager.GetClients()
	var target *schemas.MCPClientState
	for i := range states {
		if states[i].ExecutionConfig != nil && states[i].ExecutionConfig.ID == clientID {
			target = &states[i]
			break
		}
	}
	if target == nil {
		return MCPToolCallResult{IsError: true, Error: fmt.Sprintf("mcp: client %s not found", clientID)}
	}

	prefixedName := prefixedToolName(*target, toolName)
	if _, ok := target.ToolMap[prefixedName]; !ok {
		return MCPToolCallResult{IsError: true, Error: fmt.Sprintf("mcp: tool %q not found on client %q", toolName, target.ExecutionConfig.Name)}
	}

	argsJSON := "{}"
	if len(args) > 0 {
		argsJSON = string(args)
	}

	bctx := schemas.NewBifrostContext(ctx, schemas.NoDeadline)
	msg, bErr := c.bf.ExecuteChatMCPTool(bctx, &schemas.ChatAssistantMessageToolCall{
		Function: schemas.ChatAssistantMessageToolCallFunction{Name: &prefixedName, Arguments: argsJSON},
	})
	if bErr != nil {
		return MCPToolCallResult{IsError: true, Error: toError(bErr).Error()}
	}
	if msg == nil {
		return MCPToolCallResult{IsError: true, Error: "mcp: tool call returned no result"}
	}

	result := MCPToolCallResult{}
	if msg.ChatToolMessage != nil && msg.ChatToolMessage.IsError != nil {
		result.IsError = *msg.ChatToolMessage.IsError
	}
	if msg.Content != nil && msg.Content.ContentStr != nil {
		result.Content = *msg.Content.ContentStr
	}
	if result.IsError && result.Content != "" {
		result.Error = result.Content
	}
	return result
}

func toBifrostMCPConfig(cfg MCPClientConfig) (*schemas.MCPClientConfig, error) {
	bc := &schemas.MCPClientConfig{
		ID:       cfg.ID,
		Name:     cfg.Name,
		AuthType: schemas.MCPAuthTypeNone,
		// ToolsToExecute is an include-only allow-list that defaults to
		// deny-all when omitted (schemas.MCPClientConfig's own doc comment:
		// "nil/omitted => treated as [] (no tools)") -- Bifrost's gateway
		// use case wants that closed-by-default, but better-chatbot has no
		// such per-client allow-list concept at all: any tool a connected
		// MCP server reports can be called directly. "*" reproduces that
		// "no restriction" behavior. Caught live: an end-to-end tool call
		// against a real server failed with "not in client's
		// ToolsToExecute allow-list" until this was added -- no unit test
		// exercises Bifrost's real gating, since fakeMCPEngine bypasses it
		// entirely.
		ToolsToExecute: schemas.WhiteList{"*"},
	}
	switch cfg.ConnectionType {
	case MCPConnectionSTDIO:
		bc.ConnectionType = schemas.MCPConnectionTypeSTDIO
		envs := make([]string, 0, len(cfg.Env))
		for k, v := range cfg.Env {
			envs = append(envs, k+"="+v)
		}
		bc.StdioConfig = &schemas.MCPStdioConfig{Command: cfg.Command, Args: cfg.Args, Envs: envs}
	case MCPConnectionHTTP:
		bc.ConnectionType = schemas.MCPConnectionTypeHTTP
		bc.ConnectionString = schemas.NewSecretVar(cfg.URL)
		if len(cfg.Headers) > 0 {
			bc.AuthType = schemas.MCPAuthTypeHeaders
			headers := make(map[string]schemas.SecretVar, len(cfg.Headers))
			for k, v := range cfg.Headers {
				headers[k] = *schemas.NewSecretVar(v)
			}
			bc.Headers = headers
		}
	default:
		return nil, fmt.Errorf("bifrost: unknown MCP connection type %q", cfg.ConnectionType)
	}
	return bc, nil
}

func toMCPStatus(state schemas.MCPConnectionState) MCPClientStatus {
	switch state {
	case schemas.MCPConnectionStateConnected:
		return MCPStatusConnected
	case schemas.MCPConnectionStateError:
		return MCPStatusError
	default:
		return MCPStatusDisconnected
	}
}

// toMCPToolInfo recovers each tool's true original MCP name from Bifrost's
// ToolMap. ToolMap keys are "{clientName}-{originalToolName}" with the
// *original* name preserved as-is (hyphens included) -- confirmed by
// running a real MCP server (@modelcontextprotocol/server-everything)
// through AddMCPClient and inspecting the live client state directly, not
// assumed from a doc comment. ToolNameMapping (sanitizedName ->
// originalName, underscore-sanitized for LLM function-calling) is a
// separate registry Bifrost's own tool-execution/exec.go path uses; an
// earlier version of this function used it to "recover" the original name,
// which actually broke CallMCPTool's matching prefixedToolName lookup
// (built the wrong, sanitized-form key) -- caught by an end-to-end curl
// test against a real server, not by any unit test, since the fakeMCPEngine
// used elsewhere never exercised Bifrost's real ToolMap key format.
func toMCPToolInfo(s schemas.MCPClientState) []MCPToolInfo {
	prefix := s.ExecutionConfig.Name + "-"
	tools := make([]MCPToolInfo, 0, len(s.ToolMap))
	for key, t := range s.ToolMap {
		info := MCPToolInfo{Name: strings.TrimPrefix(key, prefix)}
		if t.Function != nil {
			if t.Function.Description != nil {
				info.Description = *t.Function.Description
			}
			if t.Function.Parameters != nil {
				if b, err := json.Marshal(t.Function.Parameters); err == nil {
					info.InputSchema = b
				}
			}
		}
		tools = append(tools, info)
	}
	sort.Slice(tools, func(i, j int) bool { return tools[i].Name < tools[j].Name })
	return tools
}

// prefixedToolName builds the Bifrost ToolMap key for toolName (the true
// original MCP tool name) on client state -- the inverse of
// toMCPToolInfo's name recovery, and just as direct: ToolMap keys are
// "{clientName}-{originalToolName}" with no sanitization applied.
func prefixedToolName(s schemas.MCPClientState, toolName string) string {
	return s.ExecutionConfig.Name + "-" + toolName
}
