package editor

import "testing"

func TestSuggestMentions_TriggersOnAtPrefixedLastToken(t *testing.T) {
	candidates := []Mentionable{
		{Kind: MentionDefaultTool, Name: "read_file"},
		{Kind: MentionDefaultTool, Name: "run_shell"},
		{Kind: MentionAgent, Name: "CodeReviewer", AgentID: "agent-1"},
	}

	if got := SuggestMentions("hello there", candidates); got != nil {
		t.Fatalf("SuggestMentions with no @ = %v, want nil", got)
	}
	if got := SuggestMentions("please use @read to look", candidates); got != nil {
		t.Fatalf("SuggestMentions mid-sentence (not the last token) = %v, want nil", got)
	}
	if got := SuggestMentions("please use @read", candidates); len(got) != 1 || got[0].Name != "read_file" {
		t.Fatalf("SuggestMentions(\"...@read\") = %+v, want just read_file", got)
	}
	if got := SuggestMentions("@", candidates); len(got) != 3 {
		t.Fatalf("SuggestMentions(\"@\") = %d matches, want all 3", len(got))
	}
	if got := SuggestMentions("ask @Code", candidates); len(got) != 1 || got[0].Kind != MentionAgent {
		t.Fatalf("SuggestMentions(\"...@Code\") = %+v, want the case-insensitive agent match", got)
	}
}

func TestSuggestMentions_StopsOnceTheTokenIsFinished(t *testing.T) {
	candidates := []Mentionable{{Kind: MentionDefaultTool, Name: "read_file"}}
	if got := SuggestMentions("@read_file ", candidates); got != nil {
		t.Fatalf("SuggestMentions with trailing space = %v, want nil (nothing left to complete)", got)
	}
}

func TestReplaceLastToken_SwapsOnlyTheTrailingWord(t *testing.T) {
	// ReplaceLastToken is only ever called on input SuggestMentions already
	// accepted as "still typing the last token" -- the @-prefixed word must
	// actually be the last one.
	got := ReplaceLastToken("please use @read", "@read_file")
	want := "please use @read_file"
	if got != want {
		t.Fatalf("ReplaceLastToken = %q, want %q", got, want)
	}

	// A single-token input has no preceding space to preserve.
	if got := ReplaceLastToken("@re", "@read_file"); got != "@read_file" {
		t.Fatalf("ReplaceLastToken(single token) = %q, want @read_file", got)
	}
}

func TestMCPToolMentions_NamesToolsServerQualified(t *testing.T) {
	got := MCPToolMentions("server-1", "github", []string{"create_issue", "list_prs"})
	if len(got) != 2 {
		t.Fatalf("len = %d, want 2", len(got))
	}
	if got[0].Name != "github/create_issue" || got[0].ServerID != "server-1" || got[0].Kind != MentionMCPTool {
		t.Fatalf("got[0] = %+v, want {Kind: mcpTool, Name: github/create_issue, ServerID: server-1}", got[0])
	}
	// The wire name is the bare tool name, not the server-qualified display
	// label -- chatapi's loadMcpTools matches mentions against the tool's
	// own name as the MCP server reports it.
	if got := got[0].MentionName(); got != "create_issue" {
		t.Fatalf("MentionName() = %q, want the bare tool name create_issue", got)
	}
}

// TestMentionable_MentionName_DefaultsToDisplayName covers every other
// Kind, where the wire name is just the display Name (defaultTool) or
// unused (agent/workflow/mcpServer resolve off their id fields).
func TestMentionable_MentionName_DefaultsToDisplayName(t *testing.T) {
	m := Mentionable{Kind: MentionDefaultTool, Name: "read_file"}
	if got := m.MentionName(); got != "read_file" {
		t.Fatalf("MentionName() = %q, want read_file", got)
	}
}

func TestRenderMentionSuggestions_EmptyForNoMatches(t *testing.T) {
	if got := RenderMentionSuggestions(80, nil, 0); got != "" {
		t.Fatalf("RenderMentionSuggestions with no matches = %q, want empty", got)
	}
}

func TestRenderMentionSuggestions_NeverPanicsAtNarrowWidths(t *testing.T) {
	matches := []Mentionable{{Kind: MentionDefaultTool, Name: "read_file", Help: "read a file"}}
	for _, w := range []int{0, 1, 5, 80} {
		_ = RenderMentionSuggestions(w, matches, 0)
	}
}

// TestDefaultToolMentions_ExcludesInternalOnlyTools guards the curated
// list's stated exclusions -- task, propose_plan, terminal-execution and
// the shell_task_* pair are not meant to be @-mentioned directly.
func TestDefaultToolMentions_ExcludesInternalOnlyTools(t *testing.T) {
	excluded := map[string]bool{
		"task": true, "propose_plan": true, "terminal-execution": true,
		"shell_task_output": true, "shell_task_kill": true,
	}
	for _, m := range DefaultToolMentions {
		if excluded[m.Name] {
			t.Fatalf("DefaultToolMentions includes %q, which should stay internal-only", m.Name)
		}
	}
}
