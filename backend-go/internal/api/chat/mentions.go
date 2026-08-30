// mentions.go ports shared.chat.ts's loadMcpTools/loadWorkFlowTools/
// loadAppDefaultTools mention resolution (route.go's activeAppDefaultTools
// already ports the last of the three) plus shared.chat.ts's
// filterMcpServerCustomizations and skills.go's resolveSkills. It used to
// also resolve an "agent" mention's own pre-bound instructions and
// mentions (actions.ts's rememberAgentAction); that whole function was
// removed along with the rest of the agent feature in Phase 6
// (docs/skills/).
package chat

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"

	"amiro/backend/internal/ai/prompts"
	"amiro/backend/internal/ai/tools"
	"amiro/backend/internal/ai/workflow/executor"
	"amiro/backend/internal/mcp"
	"amiro/backend/internal/skills"
)

// resolveSkills resolves every `{type: "skill", name}` mention.
// An unresolvable skill name returns an error, surfacing as a visible turn error.
// Explicit selection ignores disable-model-invocation.
func (h *Handler) resolveSkills(ctx context.Context, home, project string, mentions []mentionDTO) ([]skills.Skill, error) {
	var skillNames []string
	for _, m := range mentions {
		if m.Type == "skill" && m.Name != "" {
			skillNames = append(skillNames, m.Name)
		}
	}
	if len(skillNames) == 0 {
		return nil, nil
	}
	if h.skills == nil {
		return nil, errors.New("skill discovery service is not configured")
	}

	seen := make(map[string]bool)
	var resolved []skills.Skill
	for _, name := range skillNames {
		norm := strings.ToLower(strings.TrimSpace(name))
		if seen[norm] {
			continue
		}
		sk, err := h.skills.Get(ctx, home, project, name)
		if err != nil {
			return nil, fmt.Errorf("skill %q could not be resolved: %w", name, err)
		}
		seen[norm] = true
		resolved = append(resolved, *sk)
	}
	return resolved, nil
}

// activeMCPTools is loadMcpTools' result: the callable tool.Definitions
// plus, per server id, exactly which origin tool names ended up active --
// filterMcpServerCustomizations (shared.chat.ts:180) needs that set to
// decide which saved customizations are even relevant to this turn.
type activeMCPTools struct {
	Defs          []tools.Definition
	ToolsByServer map[string][]string // serverID -> origin tool names
	Servers       []mcp.ServerInfo    // every server the user can see, for mcpCustomizationSystemPrompt's name lookup
}

// loadMCPTools ports loadMcpTools (shared.chat.ts:396): an mcpTool/
// mcpServer mention takes priority (an mcpServer mention selects every
// tool on that server) over allowedMcpServers, which itself yields nothing
// at all when the request omits it -- MCP tools are opt-in per turn, never
// on by default, matching filterMCPToolsByAllowedMCPServers' `{}` short
// circuit.
func (h *Handler) loadMCPTools(ctx context.Context, userID string, mentions []mentionDTO, allowed map[string]allowedMCPServerDTO) (activeMCPTools, error) {
	if h.mcp == nil {
		return activeMCPTools{}, nil
	}
	servers, err := h.mcp.List(ctx, userID)
	if err != nil {
		return activeMCPTools{}, err
	}

	var mentionServers, mentionTools map[string]bool
	var toolMentionNames map[string][]string // serverID -> tool names named individually
	hasMentions := false
	for _, m := range mentions {
		if m.Type != "mcpTool" && m.Type != "mcpServer" {
			continue
		}
		hasMentions = true
		if m.ServerID == "" {
			continue
		}
		if m.Type == "mcpServer" {
			if mentionServers == nil {
				mentionServers = map[string]bool{}
			}
			mentionServers[m.ServerID] = true
		} else {
			if mentionTools == nil {
				mentionTools = map[string]bool{}
				toolMentionNames = map[string][]string{}
			}
			mentionTools[m.ServerID] = true
			toolMentionNames[m.ServerID] = append(toolMentionNames[m.ServerID], m.Name)
		}
	}

	out := activeMCPTools{ToolsByServer: map[string][]string{}, Servers: servers}
	for _, srv := range servers {
		var wantedTools map[string]bool // nil = every tool on this server
		switch {
		case hasMentions:
			if mentionServers[srv.ID] {
				wantedTools = nil // every tool
			} else if mentionTools[srv.ID] {
				wantedTools = map[string]bool{}
				for _, n := range toolMentionNames[srv.ID] {
					wantedTools[n] = true
				}
			} else {
				continue // this server wasn't mentioned at all
			}
		case len(allowed) > 0:
			a, ok := allowed[srv.ID]
			if !ok {
				continue
			}
			wantedTools = map[string]bool{}
			for _, n := range a.Tools {
				wantedTools[n] = true
			}
		default:
			continue // no mentions and no allow-list: no MCP tools this turn
		}

		for _, t := range srv.ToolInfo {
			if wantedTools != nil && !wantedTools[t.Name] {
				continue
			}
			serverID, toolName, toolInfo := srv.ID, t.Name, t
			out.Defs = append(out.Defs, tools.Definition{
				Name: mcp.ToolID(srv.Name, t.Name),
				// External: an MCP tool's side effects happen on someone
				// else's machine, and nothing here can see what they are.
				// That classification is what makes Plan mode actually
				// read-only -- without it, "read-only" would mean "reads no
				// local files while posting to Jira".
				Risk:             tools.RiskExternal,
				Description:      toolInfo.Description,
				ParametersSchema: toolInfo.InputSchema,
				Execute: func(ctx context.Context, input json.RawMessage) (any, error) {
					result := h.mcp.CallTool(ctx, serverID, toolName, input)
					if result.IsError {
						return nil, errors.New(result.Error)
					}
					return result.Content, nil
				},
			})
			out.ToolsByServer[srv.ID] = append(out.ToolsByServer[srv.ID], t.Name)
		}
	}
	return out, nil
}

// loadWorkflowTools ports loadWorkFlowTools (shared.chat.ts:409): only
// workflows explicitly @-mentioned are ever loaded (there's no
// allowedWorkflows analog to MCP's allow-list) -- each becomes one callable
// tool whose input schema is its Input node's outputSchema and whose
// Execute runs the workflow graph to completion synchronously, returning
// the last Output node's result. Simplified vs. workflowToVercelAITool's
// TS behavior: this doesn't stream per-node progress into the chat UI (the
// TS route's `dataStream.write` history), only the final result -- the
// underlying execution is identical (same internal/ai/workflow/executor
// the standalone execute route already uses).
func (h *Handler) loadWorkflowTools(ctx context.Context, mentions []mentionDTO) ([]tools.Definition, error) {
	if h.workflows == nil {
		return nil, nil
	}
	var ids []string
	for _, m := range mentions {
		if m.Type == "workflow" && m.WorkflowID != "" {
			ids = append(ids, m.WorkflowID)
		}
	}
	if len(ids) == 0 {
		return nil, nil
	}

	infos, err := h.workflows.SelectToolByIDs(ctx, ids)
	if err != nil {
		return nil, err
	}

	defs := make([]tools.Definition, 0, len(infos))
	for _, info := range infos {
		workflowID := info.ID
		description := info.Name
		if info.Description != nil && *info.Description != "" {
			description = info.Name + " " + *info.Description
		}
		defs = append(defs, tools.Definition{
			Name: mcp.SanitizeFunctionName(info.Name),
			// A workflow is a graph the user authored, and its nodes can
			// make HTTP calls and invoke tools of their own. External is the
			// honest floor: we cannot look inside and promise less.
			Risk:             tools.RiskExternal,
			Description:      description,
			ParametersSchema: info.Schema,
			Execute: func(ctx context.Context, input json.RawMessage) (any, error) {
				return h.runWorkflowTool(ctx, workflowID, input)
			},
		})
	}
	return defs, nil
}

// runWorkflowTool ports workflowToVercelAITool's execute callback
// (shared.chat.ts:246): run the workflow's node graph (same executor the
// standalone execute route uses) with the model's tool-call input as the
// query, and return the last Output node's result. A run that ends with
// isOk false (a node errored, or the graph has no Input node) surfaces as
// a tool-execution error, same as the TS route's toolResult.status ==
// "fail" branch feeding back into the model as an error result.
func (h *Handler) runWorkflowTool(ctx context.Context, workflowID string, input json.RawMessage) (any, error) {
	structure, err := h.workflows.SelectStructureByID(ctx, workflowID, true)
	if err != nil {
		return nil, err
	}
	if structure == nil {
		return nil, errors.New("workflow not found")
	}

	var query map[string]interface{}
	_ = json.Unmarshal(input, &query)

	events := executor.Run(ctx, h.workflowEngine, h.mcp, structure.Nodes, structure.Edges, query)

	var output interface{}
	isOk := true
	errMsg := ""
	for ev := range events {
		if ev.EventType != "WORKFLOW_END" {
			continue
		}
		output = ev.Output
		if ev.IsOk != nil {
			isOk = *ev.IsOk
		}
		if ev.Error != nil {
			errMsg = ev.Error.Message
		}
	}
	if !isOk {
		if errMsg == "" {
			errMsg = "workflow execution failed"
		}
		return nil, errors.New(errMsg)
	}
	return output, nil
}

// mcpCustomizationSystemPrompt ports the route's
// `rememberMcpServerCustomizationsAction` + `filterMcpServerCustomizations`
// + `buildMcpServerCustomizationsSystemPrompt` pipeline (route.ts:253-260):
// only relevant when at least one MCP tool actually loaded this turn
// (`if (Object.keys(MCP_TOOLS ?? {}).length === 0) throw ...` short
// circuits to {} otherwise), and only customizations naming a
// tool/server that's actually active are included.
func (h *Handler) mcpCustomizationSystemPrompt(ctx context.Context, userID string, toolsByServer map[string][]string, servers []mcp.ServerInfo) string {
	if len(toolsByServer) == 0 || h.mcpServerCustom == nil || h.mcpToolCustom == nil {
		return ""
	}
	serverNames := make(map[string]string, len(servers))
	for _, s := range servers {
		serverNames[s.ID] = s.Name
	}

	serverPrompts, err := h.mcpServerCustom.SelectByUserID(ctx, userID)
	if err != nil {
		return ""
	}
	toolPrompts, err := h.mcpToolCustom.SelectByUserID(ctx, userID)
	if err != nil {
		return ""
	}

	byServer := make(map[string]*prompts.McpServerCustomizationPrompt)
	for _, sp := range serverPrompts {
		activeTools, ok := toolsByServer[sp.McpServerID]
		if !ok || len(activeTools) == 0 {
			continue
		}
		if sp.Prompt == nil || *sp.Prompt == "" {
			continue
		}
		byServer[sp.McpServerID] = &prompts.McpServerCustomizationPrompt{
			ServerName: serverNames[sp.McpServerID], Prompt: *sp.Prompt, Tools: map[string]string{},
		}
	}
	for _, tp := range toolPrompts {
		activeTools, ok := toolsByServer[tp.McpServerID]
		if !ok || tp.Prompt == nil || *tp.Prompt == "" {
			continue
		}
		isActive := false
		for _, n := range activeTools {
			if n == tp.ToolName {
				isActive = true
				break
			}
		}
		if !isActive {
			continue
		}
		entry, ok := byServer[tp.McpServerID]
		if !ok {
			entry = &prompts.McpServerCustomizationPrompt{ServerName: serverNames[tp.McpServerID], Tools: map[string]string{}}
			byServer[tp.McpServerID] = entry
		}
		entry.Tools[tp.ToolName] = *tp.Prompt
	}

	ids := make([]string, 0, len(byServer))
	for id := range byServer {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	list := make([]prompts.McpServerCustomizationPrompt, 0, len(ids))
	for _, id := range ids {
		list = append(list, *byServer[id])
	}
	return prompts.BuildMcpServerCustomizationsSystemPrompt(list)
}

// mergeToolDefinitions ports the TS route's `{...MCP_TOOLS, ...WORKFLOW_TOOLS,
// ...APP_DEFAULT_TOOLS}` spread (route.ts:280-289): app-default tools are
// listed last only for the same "APP_DEFAULT_TOOLS Not Supported Manual"
// override-precedence comment the TS source has -- in this Go rewrite
// every entry has its own unique Name (MCP/workflow names never collide
// with the fixed app-default tool names), so unlike the TS object spread
// there's nothing to actually override; a duplicate name (were one ever to
// occur) is resolved by keeping the first Definition seen.
func mergeToolDefinitions(lists ...[]tools.Definition) []tools.Definition {
	seen := map[string]bool{}
	var out []tools.Definition
	for _, l := range lists {
		for _, d := range l {
			if seen[d.Name] {
				continue
			}
			seen[d.Name] = true
			out = append(out, d)
		}
	}
	return out
}
