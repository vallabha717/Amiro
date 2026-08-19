package toolcard

import (
	"encoding/json"
	"fmt"

	"amiro/backend/internal/tui/session"
	"amiro/backend/internal/tui/theme"
)

/* -------------------------------------------------------------------- */
/* read_file                                                             */
/* -------------------------------------------------------------------- */

type readFileInput struct {
	Path string `json:"path"`
}

type readFileOutput struct {
	Path      string `json:"path"`
	TotalLine int    `json:"total_lines"`
	StartLine int    `json:"start_line"`
	EndLine   int    `json:"end_line"`
	Truncated bool   `json:"truncated"`
}

func renderReadFile(width int, call session.ToolCall) string {
	var in readFileInput
	_ = json.Unmarshal(call.Input, &in)
	path := in.Path

	var body string
	if call.Status == session.ToolError {
		body = theme.Default.Error.Render(errorOrDefault(call.ErrorText))
	} else if call.Status == session.ToolDone {
		var out readFileOutput
		_ = json.Unmarshal(call.Output, &out)
		if out.Path != "" {
			path = out.Path
		}
		if out.Truncated {
			body = fmt.Sprintf("lines %d-%d of %d", out.StartLine, out.EndLine, out.TotalLine)
		} else {
			body = fmt.Sprintf("%d lines", out.TotalLine)
		}
	}

	title := "read_file · " + pathOr(path, "?") + statusSuffix(call.Status)
	return card(width, statusBorder(call.Status), title, body)
}

/* -------------------------------------------------------------------- */
/* list_dir                                                              */
/* -------------------------------------------------------------------- */

type listDirInput struct {
	Path string `json:"path"`
}

type dirEntry struct {
	Path  string `json:"path"`
	IsDir bool   `json:"is_dir"`
}

type listDirOutput struct {
	Path      string     `json:"path"`
	Entries   []dirEntry `json:"entries"`
	FileCount int        `json:"file_count"`
	DirCount  int        `json:"dir_count"`
}

func renderListDir(width int, call session.ToolCall) string {
	var in listDirInput
	_ = json.Unmarshal(call.Input, &in)
	path := pathOr(in.Path, ".")

	var body string
	if call.Status == session.ToolError {
		body = theme.Default.Error.Render(errorOrDefault(call.ErrorText))
	} else if call.Status == session.ToolDone {
		var out listDirOutput
		_ = json.Unmarshal(call.Output, &out)
		if out.Path != "" {
			path = out.Path
		}
		body = fmt.Sprintf("%d dirs · %d files", out.DirCount, out.FileCount)
	}

	title := "list_dir · " + path + statusSuffix(call.Status)
	return card(width, statusBorder(call.Status), title, body)
}

/* -------------------------------------------------------------------- */
/* glob                                                                  */
/* -------------------------------------------------------------------- */

type globInput struct {
	Pattern string `json:"pattern"`
}

type globMatch struct {
	Path string `json:"path"`
}

type globOutput struct {
	Pattern string      `json:"pattern"`
	Matches []globMatch `json:"matches"`
	Count   int         `json:"count"`
}

func renderGlob(width int, call session.ToolCall) string {
	var in globInput
	_ = json.Unmarshal(call.Input, &in)
	pattern := in.Pattern

	var body string
	if call.Status == session.ToolError {
		body = theme.Default.Error.Render(errorOrDefault(call.ErrorText))
	} else if call.Status == session.ToolDone {
		var out globOutput
		_ = json.Unmarshal(call.Output, &out)
		if out.Pattern != "" {
			pattern = out.Pattern
		}
		body = pluralCount(out.Count, "match", "matches")
		for i, m := range out.Matches {
			if i >= 3 {
				break
			}
			body += "\n" + theme.Default.Muted.Render(m.Path)
		}
	}

	title := "glob · " + pathOr(pattern, "?") + statusSuffix(call.Status)
	return card(width, statusBorder(call.Status), title, body)
}

/* -------------------------------------------------------------------- */
/* grep                                                                  */
/* -------------------------------------------------------------------- */

type grepInput struct {
	Pattern string `json:"pattern"`
}

type grepOutput struct {
	Pattern   string `json:"pattern"`
	Count     int    `json:"count"`
	FileCount int    `json:"file_count"`
}

func renderGrep(width int, call session.ToolCall) string {
	var in grepInput
	_ = json.Unmarshal(call.Input, &in)
	pattern := in.Pattern

	var body string
	if call.Status == session.ToolError {
		body = theme.Default.Error.Render(errorOrDefault(call.ErrorText))
	} else if call.Status == session.ToolDone {
		var out grepOutput
		_ = json.Unmarshal(call.Output, &out)
		if out.Pattern != "" {
			pattern = out.Pattern
		}
		body = fmt.Sprintf("%s in %s", pluralCount(out.Count, "hit", "hits"), pluralCount(out.FileCount, "file", "files"))
	}

	title := "grep · " + pathOr(pattern, "?") + statusSuffix(call.Status)
	return card(width, statusBorder(call.Status), title, body)
}

/* -------------------------------------------------------------------- */
/* write_file                                                            */
/* -------------------------------------------------------------------- */

type writeFileInput struct {
	Path string `json:"path"`
}

type writeFileOutput struct {
	Path      string `json:"path"`
	Created   bool   `json:"created"`
	Lines     int    `json:"lines"`
	Overwrote bool   `json:"overwrote"`
}

func renderWriteFile(width int, call session.ToolCall) string {
	var in writeFileInput
	_ = json.Unmarshal(call.Input, &in)
	path := in.Path

	var body string
	if call.Status == session.ToolError {
		body = theme.Default.Error.Render(errorOrDefault(call.ErrorText))
	} else if call.Status == session.ToolDone {
		var out writeFileOutput
		_ = json.Unmarshal(call.Output, &out)
		if out.Path != "" {
			path = out.Path
		}
		verb := "wrote"
		switch {
		case out.Created:
			verb = "created"
		case out.Overwrote:
			verb = "overwrote"
		}
		body = fmt.Sprintf("%s · %d lines", verb, out.Lines)
	}

	title := "write_file · " + pathOr(path, "?") + statusSuffix(call.Status)
	return card(width, statusBorder(call.Status), title, body)
}

func pluralCount(n int, singular, plural string) string {
	if n == 1 {
		return fmt.Sprintf("%d %s", n, singular)
	}
	return fmt.Sprintf("%d %s", n, plural)
}
