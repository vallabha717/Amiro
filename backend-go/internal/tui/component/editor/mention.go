// mention.go is Phase 4's `@`-mention completion: MCP tools, MCP servers,
// agents, workflows and Amiro's own default tools, all as one flat,
// prefix-filterable list -- the composer's mirror of slash.go's palette,
// for the other trigger character.
//
// The desktop app's mention input (src/components/chat-mention-input.tsx)
// is a rich-text editor: each mention is its own node carrying a JSON id
// alongside a human-readable label, so accepting one, editing around it,
// and reading it back out are all exact. A terminal composer has no nodes,
// only a string -- Suggest/Accept below chooses a different, plainer
// contract that still produces the same wire mentions array: the page
// tracks *which* Mentionable was accepted (in a slice, alongside the
// textarea's value) rather than trying to parse a mention back out of
// freeform text later. See page.Chat's pendingMentions field.
package editor

import (
	"sort"
	"strings"

	"github.com/charmbracelet/lipgloss"

	"amiro/backend/internal/tui/theme"
)

// MentionKind names what a Mentionable resolves to -- the wire values
// chatapi's mentionDTO.Type reads (client.Mention.Type mirrors these
// exactly).
type MentionKind string

const (
	MentionAgent       MentionKind = "agent"
	MentionMCPTool     MentionKind = "mcpTool"
	MentionMCPServer   MentionKind = "mcpServer"
	MentionWorkflow    MentionKind = "workflow"
	MentionDefaultTool MentionKind = "defaultTool"
)

// Mentionable is one thing `@` can complete to.
type Mentionable struct {
	Kind MentionKind

	// Name is what SuggestMentions filters against and what gets inserted
	// after "@" -- for an mcpTool this is "server/tool" so two servers
	// offering a same-named tool don't collide in the list.
	Name string

	// WireName is the name chatapi's mentionDTO.Name actually expects,
	// when it differs from the display Name above -- only for mcpTool,
	// where the wire wants the tool's own bare name ("create_issue"), not
	// the server-qualified display label ("github/create_issue"). Empty
	// for every other Kind, where mentionDTO.Name plays no role in
	// resolution (agent/workflow/mcpServer key off their id fields only,
	// per mentions.go) except defaultTool, which wants its Name as-is.
	WireName string

	// ServerID, WorkflowID, AgentID carry whichever id client.Mention needs
	// for this Kind -- empty for the kinds that don't use them.
	ServerID   string
	WorkflowID string
	AgentID    string

	Help string
}

// MentionName is what a Mention's wire "name" field should carry --
// WireName when set, Name otherwise.
func (m Mentionable) MentionName() string {
	if m.WireName != "" {
		return m.WireName
	}
	return m.Name
}

// DefaultToolMentions is the static, curated subset of Amiro's own tools a
// user can usefully @-mention -- task, propose_plan, terminal-execution and
// the shell_task_* pair are excluded because nothing about naming them
// explicitly changes what a turn does (task is added automatically when
// available; the rest are internal to a running call, not something a user
// opts into up front).
var DefaultToolMentions = []Mentionable{
	{Kind: MentionDefaultTool, Name: "read_file", Help: "read a file"},
	{Kind: MentionDefaultTool, Name: "write_file", Help: "write a file"},
	{Kind: MentionDefaultTool, Name: "edit_file", Help: "edit a file"},
	{Kind: MentionDefaultTool, Name: "multi_edit", Help: "edit a file in several places at once"},
	{Kind: MentionDefaultTool, Name: "list_dir", Help: "list a directory"},
	{Kind: MentionDefaultTool, Name: "glob", Help: "find files by pattern"},
	{Kind: MentionDefaultTool, Name: "grep", Help: "search file contents"},
	{Kind: MentionDefaultTool, Name: "run_shell", Help: "run a shell command"},
	{Kind: MentionDefaultTool, Name: "git", Help: "run a git subcommand"},
	{Kind: MentionDefaultTool, Name: "repo_map", Help: "summarize the repository structure"},
	{Kind: MentionDefaultTool, Name: "lsp", Help: "language-server queries (definitions, references)"},
	{Kind: MentionDefaultTool, Name: "todo_write", Help: "update the live plan"},
	{Kind: MentionDefaultTool, Name: "todo_read", Help: "read the live plan"},
	{Kind: MentionDefaultTool, Name: "memory_write", Help: "remember something across threads"},
	{Kind: MentionDefaultTool, Name: "memory_read", Help: "search remembered notes"},
	{Kind: MentionDefaultTool, Name: "memory_forget", Help: "forget a remembered note"},
	{Kind: MentionDefaultTool, Name: "webSearch", Help: "search the web"},
	{Kind: MentionDefaultTool, Name: "webContent", Help: "fetch a URL's content"},
	{Kind: MentionDefaultTool, Name: "http", Help: "make an HTTP request"},
	{Kind: MentionDefaultTool, Name: "walkthrough", Help: "narrate a guided tour of the codebase"},
}

// MCPToolMentions flattens a server's tool list into one Mentionable per
// tool, named "server/tool" to stay unique across servers.
func MCPToolMentions(serverID, serverName string, tools []string) []Mentionable {
	out := make([]Mentionable, len(tools))
	for i, tool := range tools {
		out[i] = Mentionable{
			Kind: MentionMCPTool, Name: serverName + "/" + tool, WireName: tool,
			ServerID: serverID, Help: "MCP tool on " + serverName,
		}
	}
	return out
}

// MCPServerMention is one server, mentionable as a whole (every tool on
// it).
func MCPServerMention(serverID, serverName string) Mentionable {
	return Mentionable{Kind: MentionMCPServer, Name: serverName, ServerID: serverID, Help: "every tool on this MCP server"}
}

// AgentMention applies an agent's system prompt and pre-bound mentions.
func AgentMention(agentID, agentName string) Mentionable {
	return Mentionable{Kind: MentionAgent, Name: agentName, AgentID: agentID, Help: "agent"}
}

// WorkflowMention runs a saved workflow as a tool.
func WorkflowMention(workflowID, workflowName string) Mentionable {
	return Mentionable{Kind: MentionWorkflow, Name: workflowName, WorkflowID: workflowID, Help: "workflow"}
}

// SuggestMentions filters candidates whose Name starts with (case-
// insensitive) the "@"-prefixed token currently being typed -- the last
// whitespace-delimited word in input, same "still being typed" rule
// Suggest (slash.go) uses for its own trigger, generalized to any position
// in the input rather than requiring it to start there: a mention can
// appear mid-sentence ("read @read_file then summarize"), where a slash
// command cannot.
func SuggestMentions(input string, candidates []Mentionable) []Mentionable {
	token, ok := lastToken(input)
	if !ok || !strings.HasPrefix(token, "@") {
		return nil
	}
	needle := strings.ToLower(token[1:])

	var out []Mentionable
	for _, c := range candidates {
		if strings.HasPrefix(strings.ToLower(c.Name), needle) {
			out = append(out, c)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// lastToken returns input's last whitespace-delimited token and whether it
// is still being typed (input does not end in whitespace, and is non-
// empty) -- shared by slash and mention triggers, which differ only in
// which prefix character and which position (whole-input vs. last-token)
// they require.
func lastToken(input string) (string, bool) {
	if input == "" || strings.ContainsAny(input[len(input)-1:], " \t\n") {
		return "", false
	}
	fields := strings.Fields(input)
	if len(fields) == 0 {
		return "", false
	}
	return fields[len(fields)-1], true
}

// ReplaceLastToken swaps input's last (still-being-typed) token for
// replacement, e.g. turning "please read @read" into "please read
// @read_file " once that suggestion is accepted -- the trailing space
// matches how slash's Tab-accept behaves, so typing continues naturally
// right after.
func ReplaceLastToken(input, replacement string) string {
	i := strings.LastIndexAny(input, " \t\n")
	if i < 0 {
		return replacement
	}
	return input[:i+1] + replacement
}

// RenderMentionSuggestions draws matches the same way RenderSuggestions
// draws slash commands -- a compact list, one row per candidate, the
// selected row highlighted.
func RenderMentionSuggestions(width int, matches []Mentionable, selected int) string {
	if len(matches) == 0 {
		return ""
	}
	var b strings.Builder
	for i, m := range matches {
		line := "@" + m.Name + "  " + m.Help
		style := theme.Default.Muted
		if i == selected {
			style = theme.Default.System.Bold(true)
		}
		if i > 0 {
			b.WriteString("\n")
		}
		b.WriteString(lipgloss.NewStyle().MaxWidth(width).Render(style.Render(line)))
	}
	return b.String()
}
