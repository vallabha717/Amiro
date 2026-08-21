package page

import (
	"context"

	tea "github.com/charmbracelet/bubbletea"

	"amiro/backend/internal/tui/client"
	"amiro/backend/internal/tui/component/editor"
)

// mentionablesLoadedMsg carries the fetched mention candidates back into
// Update -- loaded once at startup rather than on first "@", so the very
// first mention a user types already has real completions instead of an
// empty list while a fetch is still in flight.
type mentionablesLoadedMsg struct {
	candidates []editor.Mentionable
}

// loadMentionables fetches every mentionable thing beyond Amiro's own
// static tool list: agents, MCP servers and their tools, workflows. Each
// fetch failing independently degrades to "that category has no
// candidates" rather than failing the whole list -- a user with no MCP
// servers configured should still get default-tool and agent completion.
func (m Chat) loadMentionables() tea.Msg {
	ctx := context.Background()
	candidates := append([]editor.Mentionable{}, editor.DefaultToolMentions...)

	if agents, err := m.c.ListAgents(ctx); err == nil {
		for _, a := range agents {
			candidates = append(candidates, editor.AgentMention(a.ID, a.Name))
		}
	}
	if servers, err := m.c.ListMCPServers(ctx); err == nil {
		for _, s := range servers {
			candidates = append(candidates, editor.MCPServerMention(s.ID, s.Name))
			candidates = append(candidates, editor.MCPToolMentions(s.ID, s.Name, s.Tools)...)
		}
	}
	if workflows, err := m.c.ListWorkflows(ctx); err == nil {
		for _, w := range workflows {
			candidates = append(candidates, editor.WorkflowMention(w.ID, w.Name))
		}
	}
	return mentionablesLoadedMsg{candidates: candidates}
}

// skillsLoadedMsg carries the fetched skills result back into Update --
// loaded once at startup alongside mentionables with independent degradation.
type skillsLoadedMsg struct {
	result client.SkillListResult
	err    error
}

func (m Chat) loadSkills() tea.Msg {
	ctx := context.Background()
	res, err := m.c.ListSkills(ctx, m.workspaceRoot)
	return skillsLoadedMsg{result: res, err: err}
}

// toClientMention converts an accepted completion into the wire-shaped
// value SendMessageRequest.Mentions carries.
func toClientMention(m editor.Mentionable) client.Mention {
	return client.Mention{
		Type: string(m.Kind), Name: m.MentionName(),
		ServerID: m.ServerID, WorkflowID: m.WorkflowID, AgentID: m.AgentID,
	}
}
