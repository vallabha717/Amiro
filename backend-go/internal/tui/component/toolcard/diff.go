package toolcard

import (
	"encoding/json"
	"fmt"
	"strings"

	"amiro/backend/internal/tui/session"
	"amiro/backend/internal/tui/theme"
)

// maxDiffLines caps how many hunk lines a card shows -- a card is read
// while a turn is still streaming; the full diff is what the persisted
// message (and the desktop app's Expanded view) is for.
const maxDiffLines = 12

type editFileInput struct {
	Path string `json:"path"`
}

// editResult mirrors internal/ai/tools.EditResult. Hunk lines already carry
// their own "+"/"-" prefix (tools.hunkPreview), so this package only has to
// color them, never reconstruct a diff from before/after text.
type editResult struct {
	Added   int      `json:"added"`
	Removed int      `json:"removed"`
	Hunk    []string `json:"hunk"`
}

type editFileOutput struct {
	Path    string       `json:"path"`
	Edits   []editResult `json:"edits"`
	Added   int          `json:"added"`
	Removed int          `json:"removed"`
}

// renderEditFile backs both edit_file and multi_edit -- multi_edit's output
// is the same shape with more than one entry in Edits.
func renderEditFile(width int, call session.ToolCall) string {
	var in editFileInput
	_ = json.Unmarshal(call.Input, &in)
	path := in.Path

	counts := ""
	var body string
	if call.Status == session.ToolError {
		body = theme.Default.Error.Render(errorOrDefault(call.ErrorText))
	} else if call.Status == session.ToolDone {
		var out editFileOutput
		_ = json.Unmarshal(call.Output, &out)
		if out.Path != "" {
			path = out.Path
		}
		counts = fmt.Sprintf(" (+%d -%d)", out.Added, out.Removed)
		body = renderHunks(out.Edits)
	}

	title := "edit_file · " + pathOr(path, "?") + counts + statusSuffix(call.Status)
	return card(width, statusBorder(call.Status), title, body)
}

// renderHunks concatenates every edit's hunk (a blank separator between
// edits when there is more than one, so multi_edit doesn't read as one
// contiguous change), colors each line by its prefix, and caps the total
// at maxDiffLines.
func renderHunks(edits []editResult) string {
	var lines []string
	for i, e := range edits {
		if i > 0 {
			lines = append(lines, "")
		}
		lines = append(lines, e.Hunk...)
	}

	truncated := len(lines) > maxDiffLines
	if truncated {
		lines = lines[:maxDiffLines]
	}

	var b strings.Builder
	for i, l := range lines {
		if i > 0 {
			b.WriteByte('\n')
		}
		b.WriteString(colorDiffLine(l))
	}
	if truncated {
		b.WriteString("\n")
		b.WriteString(theme.Default.Muted.Render("…"))
	}
	return b.String()
}

func colorDiffLine(l string) string {
	switch {
	case l == "":
		return ""
	case strings.HasPrefix(l, "+"):
		return theme.Default.DiffAdd.Render(l)
	case strings.HasPrefix(l, "-"):
		return theme.Default.DiffRemove.Render(l)
	default:
		return theme.Default.DiffContext.Render(l)
	}
}
