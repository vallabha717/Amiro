package chat

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	bifrostai "amiro/backend/internal/ai/bifrost"
	"amiro/backend/internal/ai/tools"
	"amiro/backend/internal/db/repository"
	"amiro/backend/internal/mcp"
)

// fakeMCP is a canned MCPTools, so loadMCPTools/mcpCustomizationSystemPrompt
// tests exercise real filtering logic without a real Bifrost client or real
// MCP servers -- same substitution chatapi.Engine's fakeEngine already uses
// (chat_routes_test.go).
type fakeMCP struct {
	servers []mcp.ServerInfo
	calls   []string // "serverID:toolName:input" per CallTool invocation
}

func (f *fakeMCP) List(_ context.Context, _ string) ([]mcp.ServerInfo, error) {
	return f.servers, nil
}

func (f *fakeMCP) CallTool(_ context.Context, id, toolName string, args json.RawMessage) bifrostai.MCPToolCallResult {
	f.calls = append(f.calls, id+":"+toolName+":"+string(args))
	if toolName == "explode" {
		return bifrostai.MCPToolCallResult{IsError: true, Error: "boom"}
	}
	return bifrostai.MCPToolCallResult{Content: "ok:" + toolName}
}

func twoServerFixture() []mcp.ServerInfo {
	return []mcp.ServerInfo{
		{
			ID: "srv-a", Name: "server-a",
			ToolInfo: []bifrostai.MCPToolInfo{
				{Name: "search", Description: "search things", InputSchema: json.RawMessage(`{"type":"object"}`)},
				{Name: "explode", Description: "boom", InputSchema: json.RawMessage(`{"type":"object"}`)},
			},
		},
		{
			ID: "srv-b", Name: "server-b",
			ToolInfo: []bifrostai.MCPToolInfo{
				{Name: "search", Description: "server b search", InputSchema: json.RawMessage(`{"type":"object"}`)},
			},
		},
	}
}

func TestLoadMCPTools_NoMentionsNoAllowedYieldsNothing(t *testing.T) {
	h := &Handler{mcp: &fakeMCP{servers: twoServerFixture()}}
	got, err := h.loadMCPTools(context.Background(), "user-1", nil, nil)
	if err != nil {
		t.Fatalf("loadMCPTools: %v", err)
	}
	if len(got.Defs) != 0 {
		t.Fatalf("expected no tools with no mentions/allow-list, got %d", len(got.Defs))
	}
}

func TestLoadMCPTools_ServerMentionSelectsEveryToolOnThatServer(t *testing.T) {
	h := &Handler{mcp: &fakeMCP{servers: twoServerFixture()}}
	mentions := []mentionDTO{{Type: "mcpServer", ServerID: "srv-a", Name: "server-a"}}
	got, err := h.loadMCPTools(context.Background(), "user-1", mentions, nil)
	if err != nil {
		t.Fatalf("loadMCPTools: %v", err)
	}
	if len(got.Defs) != 2 {
		t.Fatalf("expected both srv-a tools, got %d", len(got.Defs))
	}
	if len(got.ToolsByServer["srv-a"]) != 2 || len(got.ToolsByServer["srv-b"]) != 0 {
		t.Fatalf("unexpected ToolsByServer: %#v", got.ToolsByServer)
	}
}

func TestLoadMCPTools_ToolMentionSelectsOnlyThatTool(t *testing.T) {
	h := &Handler{mcp: &fakeMCP{servers: twoServerFixture()}}
	mentions := []mentionDTO{{Type: "mcpTool", ServerID: "srv-a", Name: "search"}}
	got, err := h.loadMCPTools(context.Background(), "user-1", mentions, nil)
	if err != nil {
		t.Fatalf("loadMCPTools: %v", err)
	}
	if len(got.Defs) != 1 || got.Defs[0].Name != mcp.ToolID("server-a", "search") {
		t.Fatalf("expected exactly server-a's search tool, got %#v", got.Defs)
	}
}

func TestLoadMCPTools_AllowedServersFiltersToNamedTools(t *testing.T) {
	h := &Handler{mcp: &fakeMCP{servers: twoServerFixture()}}
	allowed := map[string]allowedMCPServerDTO{"srv-b": {Tools: []string{"search"}}}
	got, err := h.loadMCPTools(context.Background(), "user-1", nil, allowed)
	if err != nil {
		t.Fatalf("loadMCPTools: %v", err)
	}
	if len(got.Defs) != 1 || got.Defs[0].Name != mcp.ToolID("server-b", "search") {
		t.Fatalf("expected only allowed srv-b search tool, got %#v", got.Defs)
	}
}

func TestLoadMCPTools_MentionsTakePriorityOverAllowedServers(t *testing.T) {
	h := &Handler{mcp: &fakeMCP{servers: twoServerFixture()}}
	mentions := []mentionDTO{{Type: "mcpServer", ServerID: "srv-a", Name: "server-a"}}
	allowed := map[string]allowedMCPServerDTO{"srv-b": {Tools: []string{"search"}}}
	got, err := h.loadMCPTools(context.Background(), "user-1", mentions, allowed)
	if err != nil {
		t.Fatalf("loadMCPTools: %v", err)
	}
	if len(got.Defs) != 2 {
		t.Fatalf("mentions should override allow-list entirely, got %d defs", len(got.Defs))
	}
	for _, d := range got.Defs {
		if d.Name == mcp.ToolID("server-b", "search") {
			t.Fatalf("srv-b tool should not appear when a mention is present")
		}
	}
}

func TestLoadMCPTools_ExecuteCallsToolAndUnwrapsError(t *testing.T) {
	fake := &fakeMCP{servers: twoServerFixture()}
	h := &Handler{mcp: fake}
	mentions := []mentionDTO{{Type: "mcpServer", ServerID: "srv-a", Name: "server-a"}}
	got, err := h.loadMCPTools(context.Background(), "user-1", mentions, nil)
	if err != nil {
		t.Fatalf("loadMCPTools: %v", err)
	}

	for _, d := range got.Defs {
		if d.Name == mcp.ToolID("server-a", "search") {
			out, err := d.Execute(context.Background(), json.RawMessage(`{"q":"hi"}`))
			if err != nil {
				t.Fatalf("search Execute: %v", err)
			}
			if out != "ok:search" {
				t.Fatalf("unexpected search output: %v", out)
			}
		}
		if d.Name == mcp.ToolID("server-a", "explode") {
			_, err := d.Execute(context.Background(), json.RawMessage(`{}`))
			if err == nil || err.Error() != "boom" {
				t.Fatalf("expected 'boom' error from explode tool, got %v", err)
			}
		}
	}
	if len(fake.calls) != 2 {
		t.Fatalf("expected 2 CallTool invocations, got %d: %v", len(fake.calls), fake.calls)
	}
}

// fakeWorkflowTools is a canned WorkflowTools for loadWorkflowTools tests.
type fakeWorkflowTools struct {
	infos []repository.WorkflowToolInfo
}

func (f *fakeWorkflowTools) SelectToolByIDs(_ context.Context, ids []string) ([]repository.WorkflowToolInfo, error) {
	wanted := map[string]bool{}
	for _, id := range ids {
		wanted[id] = true
	}
	var out []repository.WorkflowToolInfo
	for _, info := range f.infos {
		if wanted[info.ID] {
			out = append(out, info)
		}
	}
	return out, nil
}

func (f *fakeWorkflowTools) SelectStructureByID(_ context.Context, _ string, _ bool) (*repository.WorkflowStructure, error) {
	return nil, errors.New("not used by loadWorkflowTools tests")
}

func TestLoadWorkflowTools_NoMentionsYieldsNothing(t *testing.T) {
	h := &Handler{workflows: &fakeWorkflowTools{}}
	got, err := h.loadWorkflowTools(context.Background(), nil)
	if err != nil {
		t.Fatalf("loadWorkflowTools: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("expected no workflow tools with no mentions, got %d", len(got))
	}
}

func TestLoadWorkflowTools_MentionedPublishedWorkflowBecomesATool(t *testing.T) {
	desc := "runs a report"
	fake := &fakeWorkflowTools{infos: []repository.WorkflowToolInfo{
		{ID: "wf-1", Name: "Report Runner", Description: &desc, Schema: json.RawMessage(`{"type":"object","properties":{}}`)},
	}}
	h := &Handler{workflows: fake}
	mentions := []mentionDTO{{Type: "workflow", WorkflowID: "wf-1", Name: "Report Runner"}}
	got, err := h.loadWorkflowTools(context.Background(), mentions)
	if err != nil {
		t.Fatalf("loadWorkflowTools: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("expected 1 workflow tool, got %d", len(got))
	}
	if got[0].Execute == nil {
		t.Fatalf("workflow tool should always be server-executed (never a client tool)")
	}
}

// fakeAgents is a canned AgentTools for resolveAgent tests.
type fakeAgents struct {
	byID map[string]*repository.AgentWithMeta
}

func (f *fakeAgents) SelectByID(_ context.Context, id, _ string) (*repository.AgentWithMeta, error) {
	return f.byID[id], nil
}

func TestResolveAgent_NoAgentMentionReturnsNil(t *testing.T) {
	h := &Handler{agents: &fakeAgents{byID: map[string]*repository.AgentWithMeta{}}}
	agent, mentions := h.resolveAgent(context.Background(), "user-1", []mentionDTO{{Type: "defaultTool", Name: "webSearch"}})
	if agent != nil {
		t.Fatalf("expected nil agent, got %#v", agent)
	}
	if len(mentions) != 1 {
		t.Fatalf("mentions should pass through unchanged")
	}
}

func TestResolveAgent_MergesInstructionsAndMentions(t *testing.T) {
	instr, _ := json.Marshal(map[string]any{
		"role":         "pirate captain",
		"systemPrompt": "always say arr",
		"mentions":     []mentionDTO{{Type: "defaultTool", Name: "webSearch"}},
	})
	agentRow := &repository.AgentWithMeta{}
	agentRow.ID = "agent-1"
	agentRow.Name = "Captain Bot"
	agentRow.Instructions = instr

	h := &Handler{agents: &fakeAgents{byID: map[string]*repository.AgentWithMeta{"agent-1": agentRow}}}
	mentions := []mentionDTO{{Type: "agent", AgentID: "agent-1", Name: "Captain Bot"}}
	agent, merged := h.resolveAgent(context.Background(), "user-1", mentions)

	if agent == nil {
		t.Fatalf("expected a resolved agent")
	}
	if agent.Info.Role != "pirate captain" || agent.Info.SystemPrompt != "always say arr" {
		t.Fatalf("unexpected agent info: %#v", agent.Info)
	}
	if len(merged) != 2 {
		t.Fatalf("expected the agent's own mention merged in, got %d mentions: %#v", len(merged), merged)
	}
}

func TestResolveAgent_UnknownAgentIgnoredSilently(t *testing.T) {
	h := &Handler{agents: &fakeAgents{byID: map[string]*repository.AgentWithMeta{}}}
	mentions := []mentionDTO{{Type: "agent", AgentID: "does-not-exist"}}
	agent, merged := h.resolveAgent(context.Background(), "user-1", mentions)
	if agent != nil {
		t.Fatalf("expected nil agent for an unknown/inaccessible id")
	}
	if len(merged) != 1 {
		t.Fatalf("mentions should pass through unchanged")
	}
}

func TestMergeToolDefinitions_DedupesByNameKeepingFirst(t *testing.T) {
	first := tools.Definition{Name: "dup", Description: "first"}
	second := tools.Definition{Name: "dup", Description: "second"}
	unique := tools.Definition{Name: "solo", Description: "only one"}

	got := mergeToolDefinitions([]tools.Definition{first}, []tools.Definition{second, unique})
	if len(got) != 2 {
		t.Fatalf("expected duplicate name collapsed to 1 entry + the unique one, got %d: %#v", len(got), got)
	}
	for _, d := range got {
		if d.Name == "dup" && d.Description != "first" {
			t.Fatalf("expected the first definition to win on a name collision, got description %q", d.Description)
		}
	}
}
