package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"go/parser"
	"go/token"
	"os"
	"strings"

	"amiro/backend/internal/agent/workspace"
)

func editTools(ws *workspace.Workspace) []Definition {
	if ws == nil {
		return nil
	}
	return []Definition{editFileTool(ws), multiEditTool(ws)}
}

// Edit is one anchored replacement.
//
// The format is exact-string SEARCH/REPLACE rather than a unified diff or
// line numbers. Line numbers drift the instant an earlier edit lands, and
// the diff-format literature does not agree on much except that models get
// hunk headers wrong; an exact anchor either matches or it doesn't, and
// when it doesn't the failure is loud instead of silently applying to the
// wrong place. See docs/agentic-loop-implementation-plan.md §2.1.
type Edit struct {
	OldString string `json:"old_string"`
	NewString string `json:"new_string"`
}

// EditResult describes one applied replacement, sized for the presenter's
// diff strip ("tool_loop.go · +12 −4").
type EditResult struct {
	Added   int      `json:"added"`
	Removed int      `json:"removed"`
	AtLine  int      `json:"at_line"`
	Hunk    []string `json:"hunk,omitempty"`
}

// EditFileOutput is the observation an edit produces. It deliberately does
// not echo the whole file back: the model already knows what it wrote, and
// a full re-read per edit is how an agent burns its context window.
type EditFileOutput struct {
	Path    string       `json:"path"`
	Edits   []EditResult `json:"edits"`
	Added   int          `json:"added"`
	Removed int          `json:"removed"`
	Diff    string       `json:"diff"`

	// UIView carries the file's two sides for the reviewer's diff. The
	// `ui_` prefix keeps it out of the model's context entirely -- see
	// chat.stringifyToolOutput -- so the paragraph above still holds.
	UIView *EditDiffView `json:"ui_view,omitempty"`
}

// EditDiffView is the before/after pair a side-by-side diff needs.
//
// It has to be captured here and shipped with the result, because by the
// time anyone looks at the diff the "before" side no longer exists anywhere:
// the edit already overwrote it on disk. Re-reading the file later can only
// ever show the "after".
type EditDiffView struct {
	Before string `json:"before"`
	After  string `json:"after"`

	// StartLine is the 1-based file line Before/After begin at, so the diff
	// numbers its gutters correctly even when Windowed trimmed the head off.
	StartLine int `json:"start_line"`

	// Windowed says the file was too big to ship whole and these are the
	// lines around the change. The reviewer is told, rather than being shown
	// a partial file that silently claims to be the whole one.
	Windowed bool `json:"windowed"`
}

const (
	// maxDiffViewBytes is the largest file shipped whole to the browser.
	//
	// The cost is real and recurring: this rides along in the persisted
	// message and is re-uploaded by the browser on every approval round of
	// the turn. 256KB covers essentially every hand-written source file
	// while keeping a runaway generated file from bloating the thread.
	maxDiffViewBytes = 256 * 1024

	// diffViewContextLines is how much unchanged code surrounds the change
	// when a file is too large to send whole. Generous on purpose -- the
	// point of the full-file view is seeing the change in its neighborhood,
	// and a tight window would reproduce the hunk preview this replaces.
	diffViewContextLines = 200
)

// buildDiffView captures the two sides of the file for the reviewer's diff,
// windowing around the change when the file is too large to ship whole.
func buildDiffView(original, updated string, results []EditResult) *EditDiffView {
	if len(original) <= maxDiffViewBytes && len(updated) <= maxDiffViewBytes {
		return &EditDiffView{Before: original, After: updated, StartLine: 1}
	}

	first, last := 1, 1
	for _, r := range results {
		if r.AtLine < first || first == 1 && last == 1 {
			first = r.AtLine
		}
		if end := r.AtLine + r.Removed; end > last {
			last = end
		}
	}

	oldLines := splitLines(original)
	newLines := splitLines(updated)
	start := first - diffViewContextLines
	if start < 1 {
		start = 1
	}
	clip := func(lines []string) string {
		end := last + diffViewContextLines
		if end > len(lines) {
			end = len(lines)
		}
		if start > len(lines) {
			return ""
		}
		return strings.Join(lines[start-1:end], "\n")
	}
	return &EditDiffView{
		Before:    clip(oldLines),
		After:     clip(newLines),
		StartLine: start,
		Windowed:  true,
	}
}

type editFileInput struct {
	Path      string `json:"path"`
	OldString string `json:"old_string"`
	NewString string `json:"new_string"`
}

func editFileTool(ws *workspace.Workspace) Definition {
	return Definition{
		Name:    NameEditFile,
		Toolkit: ToolkitFile,
		Risk:    RiskWrite,
		Description: "Replace an exact block of text in a file. old_string must appear EXACTLY ONCE in " +
			"the file -- include enough surrounding lines to make it unique, and copy the indentation " +
			"exactly as read_file showed it. The edit is rejected if it would leave the file " +
			"syntactically invalid.",
		ParametersSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"path": {"type": "string", "description": "Workspace-relative path to the file."},
				"old_string": {"type": "string", "description": "Exact text to find. Must be unique in the file."},
				"new_string": {"type": "string", "description": "Replacement text. Use an empty string to delete."}
			},
			"required": ["path", "old_string", "new_string"],
			"additionalProperties": false
		}`),
		Execute: func(ctx context.Context, raw json.RawMessage) (any, error) {
			var in editFileInput
			if err := json.Unmarshal(raw, &in); err != nil {
				return nil, fmt.Errorf("edit_file: %w", err)
			}
			return applyEdits(ws, in.Path, []Edit{{OldString: in.OldString, NewString: in.NewString}}, "edit_file")
		},
	}
}

type multiEditInput struct {
	Path  string `json:"path"`
	Edits []Edit `json:"edits"`
}

func multiEditTool(ws *workspace.Workspace) Definition {
	return Definition{
		Name:    NameMultiEdit,
		Toolkit: ToolkitFile,
		Risk:    RiskWrite,
		Description: "Apply several exact-text replacements to ONE file, atomically: they are applied " +
			"in order and if any anchor fails to match uniquely, nothing is written at all. Prefer this " +
			"over several edit_file calls on the same file.",
		ParametersSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"path": {"type": "string", "description": "Workspace-relative path to the file."},
				"edits": {
					"type": "array",
					"description": "Replacements, applied in order.",
					"items": {
						"type": "object",
						"properties": {
							"old_string": {"type": "string"},
							"new_string": {"type": "string"}
						},
						"required": ["old_string", "new_string"],
						"additionalProperties": false
					}
				}
			},
			"required": ["path", "edits"],
			"additionalProperties": false
		}`),
		Execute: func(ctx context.Context, raw json.RawMessage) (any, error) {
			var in multiEditInput
			if err := json.Unmarshal(raw, &in); err != nil {
				return nil, fmt.Errorf("multi_edit: %w", err)
			}
			if len(in.Edits) == 0 {
				return nil, fmt.Errorf("multi_edit: edits is empty")
			}
			return applyEdits(ws, in.Path, in.Edits, "multi_edit")
		},
	}
}

// applyEdits is the whole edit contract in one place: resolve, verify every
// anchor is unique *before* changing anything, syntax-check the result, and
// only then write. Failing at any step leaves the file exactly as it was --
// which is what makes multi_edit atomic and what stops a half-applied edit
// from compounding into the next turn.
func applyEdits(ws *workspace.Workspace, path string, edits []Edit, toolName string) (any, error) {
	abs, err := ws.Resolve(path)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(abs)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", toolName, err)
	}
	if info.IsDir() {
		return nil, fmt.Errorf("%s: %q is a directory", toolName, path)
	}
	data, err := os.ReadFile(abs)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", toolName, err)
	}
	if isBinary(data) {
		return nil, fmt.Errorf("%s: %q is not a UTF-8 text file", toolName, path)
	}

	original := string(data)
	updated := original
	results := make([]EditResult, 0, len(edits))

	for i, e := range edits {
		if e.OldString == "" {
			return nil, fmt.Errorf("%s: edit %d has an empty old_string; use write_file to create a file", toolName, i+1)
		}
		if e.OldString == e.NewString {
			return nil, fmt.Errorf("%s: edit %d makes no change (old_string equals new_string)", toolName, i+1)
		}

		count := strings.Count(updated, e.OldString)
		switch {
		case count == 0:
			return nil, fmt.Errorf(
				"%s: edit %d did not match. old_string was not found in %s. "+
					"Re-read the file and copy the exact text, including indentation%s",
				toolName, i+1, path, nearMissHint(updated, e.OldString))
		case count > 1:
			return nil, fmt.Errorf(
				"%s: edit %d is ambiguous. old_string appears %d times in %s -- "+
					"include more surrounding lines so it matches exactly once",
				toolName, i+1, count, path)
		}

		at := 1 + strings.Count(updated[:strings.Index(updated, e.OldString)], "\n")
		updated = strings.Replace(updated, e.OldString, e.NewString, 1)

		removed := len(splitLines(e.OldString))
		added := len(splitLines(e.NewString))
		results = append(results, EditResult{
			Added: added, Removed: removed, AtLine: at,
			Hunk: hunkPreview(e.OldString, e.NewString),
		})
	}

	// Syntax gate. SWE-agent's highest-leverage ACI trick: refuse an edit
	// that leaves the file unparseable, so the model fixes it now with the
	// context still in hand rather than discovering it three tool calls
	// later via a build error.
	if err := checkSyntax(abs, updated); err != nil {
		return nil, fmt.Errorf("%s: edit rejected -- it would leave %s syntactically invalid: %w. The file is unchanged", toolName, path, err)
	}

	if err := os.WriteFile(abs, []byte(updated), info.Mode().Perm()); err != nil {
		return nil, fmt.Errorf("%s: %w", toolName, err)
	}

	rel, _ := ws.Rel(abs)
	out := EditFileOutput{Path: rel, Edits: results}
	for _, r := range results {
		out.Added += r.Added
		out.Removed += r.Removed
	}
	out.Diff = strings.Join(results[0].Hunk, "\n")
	out.UIView = buildDiffView(original, updated, results)
	return out, nil
}

// checkSyntax validates the post-edit content for languages where a cheap,
// dependency-free parser exists. Everything else passes: a false rejection
// (blocking a correct edit) is worse than a missed catch, since the model
// can always recover from a build error but cannot argue with a tool that
// refuses to write.
func checkSyntax(path, content string) error {
	switch {
	case strings.HasSuffix(path, ".go"):
		fset := token.NewFileSet()
		if _, err := parser.ParseFile(fset, path, content, parser.SkipObjectResolution); err != nil {
			return err
		}
	case strings.HasSuffix(path, ".json"):
		if !json.Valid([]byte(content)) {
			return fmt.Errorf("invalid JSON")
		}
	}
	return nil
}

// nearMissHint tells the model *why* an anchor missed when the cause is a
// common, mechanical one. A bare "not found" invites the model to retry the
// identical string; naming the likely cause gets it to re-read instead.
func nearMissHint(content, old string) string {
	trimmed := strings.TrimSpace(old)
	if trimmed != old && strings.Contains(content, trimmed) {
		return " (the text exists but with different surrounding whitespace)"
	}
	if strings.Contains(old, "\r\n") && strings.Contains(content, strings.ReplaceAll(old, "\r\n", "\n")) {
		return " (line-ending mismatch: the file uses LF, not CRLF)"
	}
	// A single line of the anchor being present usually means the model
	// reconstructed the block from memory instead of from a read.
	if lines := splitLines(old); len(lines) > 1 {
		first := strings.TrimSpace(lines[0])
		if first != "" && strings.Contains(content, first) {
			return " (the first line matches but the rest of the block does not)"
		}
	}
	return ""
}

// hunkPreview renders a tiny -/+ preview of one replacement, capped so a
// large edit does not dominate the observation.
func hunkPreview(old, new string) []string {
	const maxSide = 6
	var out []string
	for i, l := range splitLines(old) {
		if i >= maxSide {
			out = append(out, "-…")
			break
		}
		out = append(out, "-"+l)
	}
	for i, l := range splitLines(new) {
		if i >= maxSide {
			out = append(out, "+…")
			break
		}
		out = append(out, "+"+l)
	}
	return out
}
