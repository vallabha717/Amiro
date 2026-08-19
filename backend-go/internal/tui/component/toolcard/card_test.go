package toolcard

import (
	"fmt"
	"testing"

	"github.com/charmbracelet/x/exp/golden"

	"amiro/backend/internal/tui/session"
)

// cardWidth is the width every golden in this file renders at -- one fixed
// width is enough here (unlike page.Chat's transcript goldens, which need
// both 80 and 120 to prove word-wrap is width-correct): a card's shape
// doesn't change across widths, only how much of its body fits, and
// bodies here are short enough to fit either.
const cardWidth = 76

// TestToolCard_Golden is the Phase 2 TUI gate's "golden per tool card
// (diff, shell, files, generic)": one golden per registered renderer, at
// pending/done/error (and, for the two calls a turn can genuinely leave
// hanging, interrupted) so a change to any renderer's output is a reviewed
// diff, not a silent visual regression.
func TestToolCard_Golden(t *testing.T) {
	cases := map[string]session.ToolCall{
		"read_file/pending": {
			Name:   "read_file",
			Input:  []byte(`{"path":"internal/api/chat/runner.go"}`),
			Status: session.ToolPending,
		},
		"read_file/done": {
			Name:   "read_file",
			Input:  []byte(`{"path":"internal/api/chat/runner.go"}`),
			Output: []byte(`{"path":"internal/api/chat/runner.go","total_lines":449,"truncated":false}`),
			Status: session.ToolDone,
		},
		"read_file/done_truncated": {
			Name:   "read_file",
			Input:  []byte(`{"path":"internal/api/chat/runner.go"}`),
			Output: []byte(`{"path":"internal/api/chat/runner.go","start_line":1,"end_line":200,"total_lines":449,"truncated":true}`),
			Status: session.ToolDone,
		},
		"read_file/error": {
			Name:      "read_file",
			Input:     []byte(`{"path":"missing.go"}`),
			Status:    session.ToolError,
			ErrorText: "open missing.go: no such file or directory",
		},

		"list_dir/done": {
			Name:   "list_dir",
			Input:  []byte(`{"path":"internal/tui"}`),
			Output: []byte(`{"path":"internal/tui","dir_count":6,"file_count":3}`),
			Status: session.ToolDone,
		},

		"glob/done": {
			Name:   "glob",
			Input:  []byte(`{"pattern":"**/*_test.go"}`),
			Output: []byte(`{"pattern":"**/*_test.go","count":2,"matches":[{"path":"internal/tui/session/reduce_test.go"},{"path":"internal/tui/page/chat_test.go"}]}`),
			Status: session.ToolDone,
		},

		"grep/done": {
			Name:   "grep",
			Input:  []byte(`{"pattern":"ToolStatus"}`),
			Output: []byte(`{"pattern":"ToolStatus","count":9,"file_count":3}`),
			Status: session.ToolDone,
		},

		"write_file/done_created": {
			Name:   "write_file",
			Input:  []byte(`{"path":"internal/tui/component/todo/panel.go"}`),
			Output: []byte(`{"path":"internal/tui/component/todo/panel.go","created":true,"lines":70}`),
			Status: session.ToolDone,
		},

		"edit_file/pending": {
			Name:   "edit_file",
			Input:  []byte(`{"path":"internal/tui/page/chat.go"}`),
			Status: session.ToolPending,
		},
		"edit_file/done": {
			Name:  "edit_file",
			Input: []byte(`{"path":"internal/tui/page/chat.go"}`),
			Output: []byte(`{"path":"internal/tui/page/chat.go","added":2,"removed":1,` +
				`"edits":[{"added":2,"removed":1,"at_line":42,"hunk":["-old line","+new line one","+new line two"]}]}`),
			Status: session.ToolDone,
		},
		"multi_edit/done": {
			Name:  "multi_edit",
			Input: []byte(`{"path":"internal/tui/page/chat.go"}`),
			Output: []byte(`{"path":"internal/tui/page/chat.go","added":3,"removed":2,"edits":[` +
				`{"added":1,"removed":1,"at_line":10,"hunk":["-a","+b"]},` +
				`{"added":2,"removed":1,"at_line":50,"hunk":["-c","+d","+e"]}` +
				`]}`),
			Status: session.ToolDone,
		},
		"edit_file/error": {
			Name:      "edit_file",
			Input:     []byte(`{"path":"internal/tui/page/chat.go"}`),
			Status:    session.ToolError,
			ErrorText: "old_string not found in file",
		},

		"run_shell/pending": {
			Name:   "run_shell",
			Input:  []byte(`{"command":"go test ./..."}`),
			Status: session.ToolPending,
		},
		"run_shell/done_success": {
			Name:   "run_shell",
			Input:  []byte(`{"command":"go test ./..."}`),
			Output: []byte(`{"command":"go test ./...","exit_code":0,"output":"ok  \tamiro/backend/internal/tui/session\t0.003s\n"}`),
			Status: session.ToolDone,
		},
		"run_shell/done_nonzero_exit": {
			Name:  "run_shell",
			Input: []byte(`{"command":"go test ./..."}`),
			Output: []byte(`{"command":"go test ./...","exit_code":1,"output":"--- FAIL: TestFoo (0.00s)\n` +
				`    foo_test.go:12: got 1, want 2\nFAIL\n"}`),
			Status: session.ToolDone,
		},
		"run_shell/done_timed_out": {
			Name:   "run_shell",
			Input:  []byte(`{"command":"sleep 999"}`),
			Output: []byte(`{"command":"sleep 999","timed_out":true,"output":""}`),
			Status: session.ToolDone,
		},
		"run_shell/interrupted": {
			Name:   "run_shell",
			Input:  []byte(`{"command":"go test ./..."}`),
			Status: session.ToolInterrupted,
		},

		"todo_write/pending": {
			Name:   "todo_write",
			Status: session.ToolPending,
		},
		"todo_write/done": {
			Name:   "todo_write",
			Output: []byte(`{"items":[{"content":"fix the bug","status":"done"},{"content":"add a test","status":"in_progress"},{"content":"update docs","status":"pending"}]}`),
			Status: session.ToolDone,
		},
		"todo_read/done_empty": {
			Name:   "todo_read",
			Output: []byte(`{"items":[]}`),
			Status: session.ToolDone,
		},

		"generic/pending": {
			Name:   "some_mcp_tool",
			Input:  []byte(`{"query":"weather in Tokyo"}`),
			Status: session.ToolPending,
		},
		"generic/done": {
			Name:   "some_mcp_tool",
			Input:  []byte(`{"query":"weather in Tokyo"}`),
			Output: []byte(`{"temperature_c":24,"condition":"clear"}`),
			Status: session.ToolDone,
		},
		"generic/error": {
			Name:      "some_mcp_tool",
			Status:    session.ToolError,
			ErrorText: "upstream returned 502",
		},
	}

	for name, call := range cases {
		t.Run(name, func(t *testing.T) {
			golden.RequireEqual(t, []byte(Render(cardWidth, call)))
		})
	}
}

// TestToolCard_UnregisteredNameDegradesToGeneric pins the fallback
// contract Render's own doc comment promises: a tool this package has no
// renderer for still produces a card, not a panic and not a blank line.
func TestToolCard_UnregisteredNameDegradesToGeneric(t *testing.T) {
	call := session.ToolCall{Name: "totally_unknown_tool", Status: session.ToolPending}
	got := Render(cardWidth, call)
	want := renderGeneric(cardWidth, call)
	if got != want {
		t.Fatalf("Render for an unregistered name did not go through renderGeneric:\ngot:  %s\nwant: %s", got, want)
	}
}

// TestToolCard_NeverPanicsOnEmptyOrMalformedIO is the width/robustness
// sibling to the width goldens above: every registered renderer, fed
// nothing (a call that hasn't reached ToolInputAvailable yet) or garbage
// JSON (a tool answering in a shape this package didn't expect), must
// still return a string -- never panic, since one bad payload should not
// take down the whole transcript.
func TestToolCard_NeverPanicsOnEmptyOrMalformedIO(t *testing.T) {
	for name, render := range registry {
		for _, status := range []session.ToolStatus{
			session.ToolPending, session.ToolDone, session.ToolError,
			session.ToolInterrupted, session.ToolAwaitingApproval,
		} {
			t.Run(fmt.Sprintf("%s/%s/empty", name, status), func(t *testing.T) {
				_ = render(cardWidth, session.ToolCall{Name: name, Status: status})
			})
			t.Run(fmt.Sprintf("%s/%s/malformed", name, status), func(t *testing.T) {
				_ = render(cardWidth, session.ToolCall{
					Name: name, Status: status,
					Input: []byte(`not json`), Output: []byte(`not json either`),
				})
			})
		}
	}
}

// TestToolCard_NarrowWidthNeverPanics guards the border/padding arithmetic
// in card() (width-4 for the inner content) against a terminal narrower
// than the card's own chrome -- lipgloss.Style.Width with a negative or
// zero value is exactly the kind of edge a hardcoded golden width would
// never exercise.
func TestToolCard_NarrowWidthNeverPanics(t *testing.T) {
	call := session.ToolCall{
		Name:   "read_file",
		Input:  []byte(`{"path":"a.go"}`),
		Output: []byte(`{"path":"a.go","total_lines":10}`),
		Status: session.ToolDone,
	}
	for _, w := range []int{0, 1, 2, 3, 4, 5} {
		_ = Render(w, call)
	}
}
