// Package toolcard renders one tool call as a bordered card: a title line
// (what, and its outcome) and a short body (the part of the result worth
// seeing at a glance). It mirrors src/components/tool-presenters' Compact
// view, not Expanded -- a transcript is read top to bottom while a turn is
// still running, and a card that dumped a tool's full output would make
// the turn's own reply the thing you have to scroll past.
//
// Every renderer here decodes a tool's input/output through its own small
// mirrored struct rather than importing internal/ai/tools -- see
// internal/tui/session/reduce.go's doc comment for why (that package sets
// the precedent this one follows).
package toolcard

import (
	"strings"

	"github.com/charmbracelet/lipgloss"

	"amiro/backend/internal/tui/session"
	"amiro/backend/internal/tui/theme"
)

// Render draws call as a card sized to width (the full width available to
// it, border included). Unregistered tool names -- any MCP tool, and any
// built-in this package hasn't grown a renderer for yet -- fall back to a
// generic card: the tool's name, its status, and a short peek at raw
// output. Degrading gracefully here matters more than covering every tool:
// a card that renders nothing for an unknown name is a transcript with a
// silent gap in it.
func Render(width int, call session.ToolCall) string {
	if r, ok := registry[call.Name]; ok {
		return r(width, call)
	}
	return renderGeneric(width, call)
}

// card draws the shared chrome every renderer uses: a rounded border in
// borderStyle's color, a bold title line, and body underneath if there is
// any. width is the card's total on-screen width; the border and one space
// of padding on each side come out of it before body text gets to wrap.
func card(width int, borderStyle lipgloss.Style, title, body string) string {
	inner := width - 4 // 2 border cols + 2 padding cols
	if inner < 1 {
		inner = 1
	}
	box := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(borderStyle.GetForeground()).
		Padding(0, 1).
		Width(inner)

	content := theme.Default.ToolTitle.Render(title)
	if body != "" {
		content += "\n" + body
	}
	return box.Render(content)
}

// statusBorder picks the card's border color for status.
func statusBorder(status session.ToolStatus) lipgloss.Style {
	switch status {
	case session.ToolDone:
		return theme.Default.ToolBorderDone
	case session.ToolError:
		return theme.Default.ToolBorderError
	case session.ToolInterrupted:
		return theme.Default.ToolBorderInterrupted
	default:
		return theme.Default.ToolBorderPending
	}
}

// statusSuffix is the generic " · running…" / " · failed" / " ·
// interrupted" a title line appends for every status except Done -- Done
// has no generic suffix because what a finished call has to say (line
// count, exit code, match count) is specific to the tool, which is exactly
// what each renderer's own body/title logic supplies instead.
func statusSuffix(status session.ToolStatus) string {
	switch status {
	case session.ToolPending:
		return " · running…"
	case session.ToolAwaitingApproval:
		return " · awaiting approval"
	case session.ToolError:
		return " · failed"
	case session.ToolInterrupted:
		return " · interrupted"
	default:
		return ""
	}
}

func errorOrDefault(errorText string) string {
	if errorText == "" {
		return "failed"
	}
	return errorText
}

func pathOr(path, fallback string) string {
	if path == "" {
		return fallback
	}
	return path
}

// firstLine returns s's first line, eliding it past max runes -- a
// glance/title line has to stay on one line, and a shell command is
// routinely longer than that.
func firstLine(s string, max int) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	r := []rune(s)
	if len(r) > max {
		return string(r[:max-1]) + "…"
	}
	return s
}

// tailLines returns s's last n lines, prefixed with a marker when earlier
// lines were cut -- output tails are more useful than heads for a command
// that's still running or just failed (the interesting part is usually at
// the end), the same reasoning src/components/ui/terminal-window.tsx's
// auto-scroll follows.
func tailLines(s string, n int) string {
	s = strings.TrimRight(s, "\n")
	if s == "" {
		return ""
	}
	lines := strings.Split(s, "\n")
	if len(lines) <= n {
		return s
	}
	return "…\n" + strings.Join(lines[len(lines)-n:], "\n")
}

// renderGeneric is the fallback for any tool name this package has no
// dedicated renderer for.
func renderGeneric(width int, call session.ToolCall) string {
	var body string
	switch call.Status {
	case session.ToolError:
		body = theme.Default.Error.Render(errorOrDefault(call.ErrorText))
	case session.ToolDone:
		body = tailLines(string(call.Output), 6)
	}
	title := call.Name + statusSuffix(call.Status)
	return card(width, statusBorder(call.Status), title, body)
}
