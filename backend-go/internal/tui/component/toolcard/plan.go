package toolcard

import (
	"encoding/json"
	"fmt"

	"amiro/backend/internal/tui/session"
	"amiro/backend/internal/tui/theme"
)

// todoOutput mirrors internal/ai/tools.TodoList -- the shape both
// todo_write and todo_read answer with.
type todoOutput struct {
	Items []session.TodoItem `json:"items"`
}

// renderPlan backs both todo_write and todo_read. It stays a one-line
// summary rather than listing every item: component/todo's panel is
// already the live, always-visible view of the full plan (session.State
// tracks it thread-wide, not per-call, in reduce.go's observeToolOutput),
// so this card only has to say "the plan changed" and roughly how.
func renderPlan(width int, call session.ToolCall) string {
	var body string
	if call.Status == session.ToolError {
		body = theme.Default.Error.Render(errorOrDefault(call.ErrorText))
	} else if call.Status == session.ToolDone {
		var out todoOutput
		_ = json.Unmarshal(call.Output, &out)
		done, inProgress, pending := 0, 0, 0
		for _, it := range out.Items {
			switch it.Status {
			case session.TodoDone:
				done++
			case session.TodoInProgress:
				inProgress++
			default:
				pending++
			}
		}
		body = fmt.Sprintf("%d done · %d in progress · %d pending", done, inProgress, pending)
	}

	title := call.Name + statusSuffix(call.Status)
	return card(width, statusBorder(call.Status), title, body)
}
