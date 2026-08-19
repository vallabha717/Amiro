// Package todo renders session.State's live plan (whatever the last
// todo_write/todo_read call reported) as a one-line summary -- the chat
// page reserves exactly one row of chrome for it, present only when there
// is something to show, so a thread with no plan looks exactly like Phase
// 1's layout.
package todo

import (
	"fmt"

	"amiro/backend/internal/tui/session"
	"amiro/backend/internal/tui/theme"
)

// Render draws one line: counts, then the item actually in progress (the
// one thing worth naming -- pending items are "up next", not "happening").
// Empty when items is empty, so a caller can always append the result
// without checking first.
func Render(width int, items []session.TodoItem) string {
	if len(items) == 0 {
		return ""
	}

	done, inProgress, pending := 0, 0, 0
	var current string
	for _, it := range items {
		switch it.Status {
		case session.TodoDone:
			done++
		case session.TodoInProgress:
			inProgress++
			if current == "" {
				current = it.Content
			}
		default:
			pending++
		}
	}

	summary := fmt.Sprintf("[%s] %d/%d done", glyph(done, len(items)), done, len(items))
	line := theme.Default.Muted.Render(summary)
	if current != "" {
		line += "  " + theme.Default.TodoInProgress.Render(truncate(current, width-len(summary)-2))
	}
	return line
}

// glyph is the panel's one at-a-glance mark: complete, in progress, or not
// started -- ASCII, see theme.Theme's doc comment on why.
func glyph(done, total int) string {
	switch {
	case total > 0 && done == total:
		return "x"
	case done > 0:
		return "~"
	default:
		return " "
	}
}

func truncate(s string, max int) string {
	if max < 1 {
		return ""
	}
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	if max == 1 {
		return "…"
	}
	return string(r[:max-1]) + "…"
}
