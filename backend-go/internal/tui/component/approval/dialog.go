// Package approval renders the modal a data-tool-approval frame opens --
// the terminal's half of plan §2.4: receive the frame, show this, resubmit
// with the answer on y/n/a. It renders from the request and the call's raw
// input alone, the same "nothing has run yet" contract the desktop app's
// ToolApprovalCard documents (src/components/tool-presenters/approval-card.tsx).
package approval

import (
	"bytes"
	"encoding/json"
	"strings"

	"github.com/charmbracelet/lipgloss"

	"amiro/backend/internal/tui/session"
	"amiro/backend/internal/tui/theme"
)

// riskLabel mirrors approval-card.tsx's RISK_LABEL exactly -- the two
// surfaces should read the same sentence for the same risk.
var riskLabel = map[string]string{
	"read":         "reads",
	"write":        "writes to your files",
	"exec":         "runs a command",
	"external":     "reaches outside this machine",
	"unclassified": "is unclassified",
}

// maxInputLines bounds the raw-input fallback preview -- a card that dumped
// a large write_file body would push the y/n/a hint off screen, which is
// the one line here that must never scroll out of view.
const maxInputLines = 8

// Render draws the dialog for req at width, sized to the full width
// available to it (border included) -- the same convention toolcard.Render
// uses.
func Render(width int, req session.ApprovalRequest, input json.RawMessage) string {
	inner := width - 4 // 2 border cols + 2 padding cols
	if inner < 1 {
		inner = 1
	}
	box := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(theme.Default.Approval.GetForeground()).
		Padding(0, 1).
		Width(inner)

	var b strings.Builder
	label := riskLabel[req.Risk]
	if label == "" {
		label = req.Risk
	}
	title := "Approve " + req.ToolName + "?"
	if label != "" {
		title += "  ·  " + label
	}
	b.WriteString(theme.Default.Approval.Render(title))
	b.WriteString("\n")

	b.WriteString(preview(input, req, inner))

	if req.Compound {
		b.WriteString("\n")
		b.WriteString(theme.Default.Error.Render(
			"⚠ this command chains or redirects -- it can do more than the first part suggests",
		))
	}

	if req.Reason != "" {
		b.WriteString("\n")
		b.WriteString(theme.Default.Muted.Render(req.Reason))
	}

	b.WriteString("\n\n")
	b.WriteString(hint())

	return box.Render(b.String())
}

// preview shows what the call will do: the literal command for a
// command-shaped call (already resolved server-side, into req.Command --
// suspendForApproval computes this the same way the permission engine
// itself sees it), or the raw input otherwise, matching the desktop app's
// own fallback ("show the arguments rather than nothing").
func preview(input json.RawMessage, req session.ApprovalRequest, width int) string {
	if req.Command != "" {
		return "$ " + firstLine(req.Command, width)
	}
	return indentedJSON(input, maxInputLines)
}

func hint() string {
	return theme.Default.Muted.Render("[y] approve once   [a] always allow   [n] deny")
}

func firstLine(s string, max int) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	r := []rune(s)
	if max > 0 && len(r) > max {
		return string(r[:max-1]) + "…"
	}
	return s
}

// indentedJSON pretty-prints input, truncated to maxLines -- the same
// "show the arguments" fallback the desktop app uses when a tool has no
// dedicated presenter.
func indentedJSON(input json.RawMessage, maxLines int) string {
	if len(input) == 0 {
		return theme.Default.Muted.Render("(no arguments)")
	}
	var buf bytes.Buffer
	if err := json.Indent(&buf, input, "", "  "); err != nil {
		return string(input)
	}
	lines := strings.Split(strings.TrimRight(buf.String(), "\n"), "\n")
	if len(lines) > maxLines {
		lines = append(lines[:maxLines], "…")
	}
	return strings.Join(lines, "\n")
}
