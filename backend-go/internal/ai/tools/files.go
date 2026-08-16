package tools

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf8"

	"amiro/backend/internal/agent/workspace"
)

// Budgets for what a single file tool may put into the model's context.
//
// These are the difference between an agent that can work in a real repo
// and one that blows its context window on the third call. Every limit
// here is *reported* when it bites -- a silent truncation teaches the model
// that it has seen the whole file, and it will confidently edit against
// content that isn't there.
const (
	readFileDefaultLines = 2000
	readFileMaxBytes     = 1 << 20 // 1 MiB, before line limits apply
	listDirMaxEntries    = 500
	listDirDefaultDepth  = 2
	listDirMaxDepth      = 10
	writeFileMaxBytes    = 5 << 20
)

// fileTools returns the workspace-scoped read/list/write toolkit. A nil
// workspace disables the whole set: no root means no safe way to resolve a
// model-supplied path, and the correct answer to that is to not offer the
// tools at all rather than to guess at a default.
func fileTools(ws *workspace.Workspace) []Definition {
	if ws == nil {
		return nil
	}
	return []Definition{
		readFileTool(ws),
		listDirTool(ws),
		writeFileTool(ws),
	}
}

type readFileInput struct {
	Path   string `json:"path"`
	Offset int    `json:"offset"`
	Limit  int    `json:"limit"`
}

// ReadFileOutput is what read_file hands back. Fields are named for the
// presenter that renders them (src/components/tool-presenters), so the
// glance line -- "src/lib/utils.ts · 120 lines" -- can be built without
// re-parsing Content.
type ReadFileOutput struct {
	Path      string `json:"path"`
	Content   string `json:"content"`
	StartLine int    `json:"start_line"`
	EndLine   int    `json:"end_line"`
	TotalLine int    `json:"total_lines"`
	Truncated bool   `json:"truncated"`
	Notice    string `json:"notice,omitempty"`
}

func readFileTool(ws *workspace.Workspace) Definition {
	return Definition{
		Name:    NameReadFile,
		Toolkit: ToolkitFile,
		Risk:    RiskRead,
		Description: "Read a UTF-8 text file from the workspace. Returns line-numbered content. " +
			"Large files are windowed: pass offset (1-based first line) and limit to page through " +
			"one. Always read a file before editing it.",
		ParametersSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"path": {"type": "string", "description": "Workspace-relative path to the file."},
				"offset": {"type": "integer", "description": "1-based line to start at. Default 1."},
				"limit": {"type": "integer", "description": "Maximum lines to return. Default 2000."}
			},
			"required": ["path"],
			"additionalProperties": false
		}`),
		Execute: func(ctx context.Context, raw json.RawMessage) (any, error) {
			var in readFileInput
			if err := json.Unmarshal(raw, &in); err != nil {
				return nil, fmt.Errorf("read_file: %w", err)
			}
			abs, err := ws.Resolve(in.Path)
			if err != nil {
				return nil, err
			}
			info, err := os.Stat(abs)
			if err != nil {
				return nil, fmt.Errorf("read_file: %w", err)
			}
			if info.IsDir() {
				return nil, fmt.Errorf("read_file: %q is a directory -- use list_dir", in.Path)
			}
			if info.Size() > readFileMaxBytes {
				return nil, fmt.Errorf("read_file: %q is %d bytes, over the %d byte limit; use grep to find the part you need",
					in.Path, info.Size(), readFileMaxBytes)
			}

			data, err := os.ReadFile(abs)
			if err != nil {
				return nil, fmt.Errorf("read_file: %w", err)
			}
			if isBinary(data) {
				return nil, fmt.Errorf("read_file: %q looks like a binary file, not UTF-8 text", in.Path)
			}

			rel, _ := ws.Rel(abs)
			lines := splitLines(string(data))

			start := in.Offset
			if start <= 0 {
				start = 1
			}
			if start > len(lines) {
				return ReadFileOutput{
					Path: rel, StartLine: start, EndLine: start, TotalLine: len(lines),
					Notice: fmt.Sprintf("offset %d is past the end of the file (%d lines)", start, len(lines)),
				}, nil
			}
			limit := in.Limit
			if limit <= 0 {
				limit = readFileDefaultLines
			}
			end := start + limit - 1
			truncated := false
			if end >= len(lines) {
				end = len(lines)
			} else {
				truncated = true
			}

			var b strings.Builder
			for i := start; i <= end; i++ {
				fmt.Fprintf(&b, "%6d\t%s\n", i, lines[i-1])
			}

			out := ReadFileOutput{
				Path: rel, Content: b.String(),
				StartLine: start, EndLine: end, TotalLine: len(lines), Truncated: truncated,
			}
			if truncated {
				out.Notice = fmt.Sprintf("showing lines %d-%d of %d; call again with offset=%d for more",
					start, end, len(lines), end+1)
			}
			return out, nil
		},
	}
}

type listDirInput struct {
	Path  string `json:"path"`
	Depth int    `json:"depth"`
}

// DirEntry is one row of a list_dir listing.
type DirEntry struct {
	Path  string `json:"path"`
	IsDir bool   `json:"is_dir"`
	Size  int64  `json:"size"`
}

// ListDirOutput carries the counts the presenter's glance line needs
// ("src/components/ · 24 entries") without walking Entries again.
type ListDirOutput struct {
	Path      string     `json:"path"`
	Entries   []DirEntry `json:"entries"`
	FileCount int        `json:"file_count"`
	DirCount  int        `json:"dir_count"`
	Truncated bool       `json:"truncated"`
	Notice    string     `json:"notice,omitempty"`
}

func listDirTool(ws *workspace.Workspace) Definition {
	return Definition{
		Name:    NameListDir,
		Toolkit: ToolkitFile,
		Risk:    RiskRead,
		Description: "List a directory in the workspace. Skips .git, node_modules and anything the " +
			"repo's .gitignore excludes. Use this to orient yourself before reading files.",
		ParametersSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"path": {"type": "string", "description": "Workspace-relative directory. Default the workspace root."},
				"depth": {"type": "integer", "description": "How many levels to descend. Default 2, max 10."}
			},
			"additionalProperties": false
		}`),
		Execute: func(ctx context.Context, raw json.RawMessage) (any, error) {
			var in listDirInput
			if err := json.Unmarshal(raw, &in); err != nil {
				return nil, fmt.Errorf("list_dir: %w", err)
			}
			if strings.TrimSpace(in.Path) == "" {
				in.Path = "."
			}
			abs, err := ws.Resolve(in.Path)
			if err != nil {
				return nil, err
			}
			info, err := os.Stat(abs)
			if err != nil {
				return nil, fmt.Errorf("list_dir: %w", err)
			}
			if !info.IsDir() {
				return nil, fmt.Errorf("list_dir: %q is a file -- use read_file", in.Path)
			}

			depth := in.Depth
			if depth <= 0 {
				depth = listDirDefaultDepth
			}
			if depth > listDirMaxDepth {
				depth = listDirMaxDepth
			}

			ig := loadIgnore(ws.Root())
			out := ListDirOutput{}
			out.Path, _ = ws.Rel(abs)

			err = filepath.WalkDir(abs, func(p string, d os.DirEntry, err error) error {
				if err != nil {
					return nil // unreadable entries are skipped, not fatal
				}
				if p == abs {
					return nil
				}
				rel, relErr := filepath.Rel(abs, p)
				if relErr != nil {
					return nil
				}
				if strings.Count(rel, string(filepath.Separator)) >= depth {
					if d.IsDir() {
						return filepath.SkipDir
					}
				}
				wsRel, _ := ws.Rel(p)
				if ig.match(wsRel, d.IsDir()) {
					if d.IsDir() {
						return filepath.SkipDir
					}
					return nil
				}
				if len(out.Entries) >= listDirMaxEntries {
					out.Truncated = true
					return filepath.SkipAll
				}
				e := DirEntry{Path: rel, IsDir: d.IsDir()}
				if fi, statErr := d.Info(); statErr == nil && !d.IsDir() {
					e.Size = fi.Size()
				}
				if d.IsDir() {
					out.DirCount++
				} else {
					out.FileCount++
				}
				out.Entries = append(out.Entries, e)
				return nil
			})
			if err != nil {
				return nil, fmt.Errorf("list_dir: %w", err)
			}
			sort.Slice(out.Entries, func(i, j int) bool { return out.Entries[i].Path < out.Entries[j].Path })
			if out.Truncated {
				out.Notice = fmt.Sprintf("listing capped at %d entries; narrow the path or reduce depth", listDirMaxEntries)
			}
			return out, nil
		},
	}
}

type writeFileInput struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

// WriteFileOutput reports what happened so the presenter can say
// "+ created foo.go · 210 lines" versus an overwrite.
type WriteFileOutput struct {
	Path      string `json:"path"`
	Created   bool   `json:"created"`
	Lines     int    `json:"lines"`
	Bytes     int    `json:"bytes"`
	Overwrote bool   `json:"overwrote"`
}

func writeFileTool(ws *workspace.Workspace) Definition {
	return Definition{
		Name:    NameWriteFile,
		Toolkit: ToolkitFile,
		// Write, which also makes it sequential: two writes the model
		// expects to land in order must land in order, and a write racing a
		// read of the same path is a coin flip.
		Risk: RiskWrite,
		Description: "Create a file, or replace one entirely. To change part of an existing file use " +
			"edit_file instead -- this overwrites the whole thing. Parent directories are created as needed.",
		ParametersSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"path": {"type": "string", "description": "Workspace-relative path."},
				"content": {"type": "string", "description": "Full file contents."}
			},
			"required": ["path", "content"],
			"additionalProperties": false
		}`),
		Execute: func(ctx context.Context, raw json.RawMessage) (any, error) {
			var in writeFileInput
			if err := json.Unmarshal(raw, &in); err != nil {
				return nil, fmt.Errorf("write_file: %w", err)
			}
			if len(in.Content) > writeFileMaxBytes {
				return nil, fmt.Errorf("write_file: content is %d bytes, over the %d byte limit", len(in.Content), writeFileMaxBytes)
			}
			abs, err := ws.Resolve(in.Path)
			if err != nil {
				return nil, err
			}
			if info, statErr := os.Stat(abs); statErr == nil && info.IsDir() {
				return nil, fmt.Errorf("write_file: %q is a directory", in.Path)
			}

			_, statErr := os.Stat(abs)
			existed := statErr == nil

			if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
				return nil, fmt.Errorf("write_file: %w", err)
			}
			if err := os.WriteFile(abs, []byte(in.Content), 0o644); err != nil {
				return nil, fmt.Errorf("write_file: %w", err)
			}

			rel, _ := ws.Rel(abs)
			return WriteFileOutput{
				Path: rel, Created: !existed, Overwrote: existed,
				Lines: len(splitLines(in.Content)), Bytes: len(in.Content),
			}, nil
		},
	}
}

// splitLines splits on \n and drops the trailing empty element a final
// newline produces, so a 3-line file reports 3 lines rather than 4.
func splitLines(s string) []string {
	if s == "" {
		return nil
	}
	lines := strings.Split(s, "\n")
	if len(lines) > 0 && lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	return lines
}

// isBinary reports whether data looks like something the model should not
// be shown. A NUL byte in the first block is the classic signal; invalid
// UTF-8 catches the rest.
func isBinary(data []byte) bool {
	head := data
	if len(head) > 8000 {
		head = head[:8000]
	}
	if bytes.IndexByte(head, 0) >= 0 {
		return true
	}
	return !utf8.Valid(head)
}

// ignoreSet is a deliberately small .gitignore reader: it covers the
// patterns that actually matter for keeping an agent out of build output
// and dependency trees, and nothing else.
//
// Not supported: negation (!), ** spanning multiple segments, and nested
// per-directory .gitignore files. Those exist to make `git status` exactly
// right; here the cost of missing one is that the agent sees a file it
// could have skipped, which is a listing annoyance rather than a
// correctness problem. Containment -- the thing that would be a real
// problem to get wrong -- is workspace.Resolve's job, not this.
type ignoreSet struct {
	patterns []string
}

// alwaysIgnored is skipped regardless of .gitignore. These are never worth
// an agent's context and are frequently enormous.
var alwaysIgnored = []string{".git", "node_modules", ".next", "dist", "build", "target", "vendor", ".venv", "__pycache__"}

func loadIgnore(root string) *ignoreSet {
	ig := &ignoreSet{}
	f, err := os.Open(filepath.Join(root, ".gitignore"))
	if err != nil {
		return ig
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, "!") {
			continue
		}
		ig.patterns = append(ig.patterns, strings.Trim(line, "/"))
	}
	return ig
}

func (ig *ignoreSet) match(relPath string, isDir bool) bool {
	base := filepath.Base(relPath)
	for _, name := range alwaysIgnored {
		if base == name {
			return true
		}
	}
	for _, pat := range ig.patterns {
		if pat == base || pat == relPath {
			return true
		}
		if ok, _ := filepath.Match(pat, base); ok {
			return true
		}
		// A directory pattern also hides everything beneath it.
		if strings.HasPrefix(relPath, pat+string(filepath.Separator)) {
			return true
		}
	}
	return false
}
