package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"amiro/backend/internal/agent/workspace"
)

const (
	globMaxResults    = 300
	grepMaxMatches    = 100
	grepMaxFileBytes  = 1 << 20
	grepContextClamp  = 5
	grepPreviewMaxLen = 300
)

func searchTools(ws *workspace.Workspace) []Definition {
	if ws == nil {
		return nil
	}
	return []Definition{globTool(ws), grepTool(ws)}
}

type globInput struct {
	Pattern string `json:"pattern"`
	Path    string `json:"path"`
}

// GlobMatch is one path, with the mtime the ordering is based on.
type GlobMatch struct {
	Path    string `json:"path"`
	ModTime int64  `json:"mod_time"`
}

type GlobOutput struct {
	Pattern   string      `json:"pattern"`
	Matches   []GlobMatch `json:"matches"`
	Count     int         `json:"count"`
	Truncated bool        `json:"truncated"`
	Notice    string      `json:"notice,omitempty"`
}

func globTool(ws *workspace.Workspace) Definition {
	return Definition{
		Name:    NameGlob,
		Toolkit: ToolkitFile,
		Risk:    RiskRead,
		Description: "Find files by path pattern. Supports * (within one path segment) and ** (across " +
			"segments), e.g. **/*.tsx or src/**/handler.go. Results are newest-first, which puts the " +
			"files someone has actually been working on at the top.",
		ParametersSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"pattern": {"type": "string", "description": "Glob pattern, matched against workspace-relative paths."},
				"path": {"type": "string", "description": "Directory to search under. Default the workspace root."}
			},
			"required": ["pattern"],
			"additionalProperties": false
		}`),
		Execute: func(ctx context.Context, raw json.RawMessage) (any, error) {
			var in globInput
			if err := json.Unmarshal(raw, &in); err != nil {
				return nil, fmt.Errorf("glob: %w", err)
			}
			if strings.TrimSpace(in.Pattern) == "" {
				return nil, fmt.Errorf("glob: pattern is required")
			}
			root, err := resolveSearchRoot(ws, in.Path)
			if err != nil {
				return nil, err
			}
			re, err := globToRegexp(in.Pattern)
			if err != nil {
				return nil, fmt.Errorf("glob: %w", err)
			}

			ig := loadIgnore(ws.Root())
			out := GlobOutput{Pattern: in.Pattern}

			walkErr := filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
				if err != nil {
					return nil
				}
				wsRel, relErr := ws.Rel(p)
				if relErr != nil {
					return nil
				}
				if p != root && ig.match(wsRel, d.IsDir()) {
					if d.IsDir() {
						return filepath.SkipDir
					}
					return nil
				}
				if d.IsDir() {
					return nil
				}
				if !re.MatchString(filepath.ToSlash(wsRel)) {
					return nil
				}
				if len(out.Matches) >= globMaxResults {
					out.Truncated = true
					return filepath.SkipAll
				}
				var mod int64
				if fi, statErr := d.Info(); statErr == nil {
					mod = fi.ModTime().Unix()
				}
				out.Matches = append(out.Matches, GlobMatch{Path: wsRel, ModTime: mod})
				return nil
			})
			if walkErr != nil {
				return nil, fmt.Errorf("glob: %w", walkErr)
			}

			sort.SliceStable(out.Matches, func(i, j int) bool {
				if out.Matches[i].ModTime != out.Matches[j].ModTime {
					return out.Matches[i].ModTime > out.Matches[j].ModTime
				}
				return out.Matches[i].Path < out.Matches[j].Path
			})
			out.Count = len(out.Matches)
			if out.Truncated {
				out.Notice = fmt.Sprintf("stopped at %d matches; narrow the pattern", globMaxResults)
			}
			if out.Count == 0 {
				out.Notice = "no files matched"
			}
			return out, nil
		},
	}
}

type grepInput struct {
	Pattern       string `json:"pattern"`
	Path          string `json:"path"`
	Include       string `json:"include"`
	ContextLines  int    `json:"context_lines"`
	CaseSensitive bool   `json:"case_sensitive"`
}

// GrepHit is one matching line plus the lines around it.
type GrepHit struct {
	Path    string   `json:"path"`
	Line    int      `json:"line"`
	Text    string   `json:"text"`
	Before  []string `json:"before,omitempty"`
	After   []string `json:"after,omitempty"`
	Preview string   `json:"preview"`
}

// GrepOutput's FileCount is what lets the presenter say "3 hits in 2 files"
// without grouping Hits itself.
type GrepOutput struct {
	Pattern   string    `json:"pattern"`
	Hits      []GrepHit `json:"hits"`
	Count     int       `json:"count"`
	FileCount int       `json:"file_count"`
	Truncated bool      `json:"truncated"`
	Notice    string    `json:"notice,omitempty"`
}

func grepTool(ws *workspace.Workspace) Definition {
	return Definition{
		Name:    NameGrep,
		Toolkit: ToolkitFile,
		Risk:    RiskRead,
		Description: "Search file contents by regular expression (Go/RE2 syntax). Returns matching lines " +
			"with their file and line number. Prefer this over reading whole files when you are looking " +
			"for something specific.",
		ParametersSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"pattern": {"type": "string", "description": "Regular expression to search for."},
				"path": {"type": "string", "description": "Directory to search under. Default the workspace root."},
				"include": {"type": "string", "description": "Only search files matching this glob, e.g. **/*.go"},
				"context_lines": {"type": "integer", "description": "Lines of context above and below each hit. Default 0, max 5."},
				"case_sensitive": {"type": "boolean", "description": "Default false."}
			},
			"required": ["pattern"],
			"additionalProperties": false
		}`),
		Execute: func(ctx context.Context, raw json.RawMessage) (any, error) {
			var in grepInput
			if err := json.Unmarshal(raw, &in); err != nil {
				return nil, fmt.Errorf("grep: %w", err)
			}
			if strings.TrimSpace(in.Pattern) == "" {
				return nil, fmt.Errorf("grep: pattern is required")
			}
			expr := in.Pattern
			if !in.CaseSensitive {
				expr = "(?i)" + expr
			}
			re, err := regexp.Compile(expr)
			if err != nil {
				return nil, fmt.Errorf("grep: invalid pattern: %w", err)
			}
			root, err := resolveSearchRoot(ws, in.Path)
			if err != nil {
				return nil, err
			}
			var includeRe *regexp.Regexp
			if strings.TrimSpace(in.Include) != "" {
				includeRe, err = globToRegexp(in.Include)
				if err != nil {
					return nil, fmt.Errorf("grep: invalid include: %w", err)
				}
			}
			cx := in.ContextLines
			if cx < 0 {
				cx = 0
			}
			if cx > grepContextClamp {
				cx = grepContextClamp
			}

			ig := loadIgnore(ws.Root())
			out := GrepOutput{Pattern: in.Pattern}
			files := map[string]bool{}

			walkErr := filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
				if err != nil {
					return nil
				}
				if ctx.Err() != nil {
					return ctx.Err()
				}
				wsRel, relErr := ws.Rel(p)
				if relErr != nil {
					return nil
				}
				if p != root && ig.match(wsRel, d.IsDir()) {
					if d.IsDir() {
						return filepath.SkipDir
					}
					return nil
				}
				if d.IsDir() {
					return nil
				}
				if includeRe != nil && !includeRe.MatchString(filepath.ToSlash(wsRel)) {
					return nil
				}
				if fi, statErr := d.Info(); statErr != nil || fi.Size() > grepMaxFileBytes {
					return nil
				}
				data, readErr := os.ReadFile(p)
				if readErr != nil || isBinary(data) {
					return nil
				}

				lines := splitLines(string(data))
				for i, line := range lines {
					if !re.MatchString(line) {
						continue
					}
					if len(out.Hits) >= grepMaxMatches {
						out.Truncated = true
						return filepath.SkipAll
					}
					hit := GrepHit{Path: wsRel, Line: i + 1, Text: clampLine(line), Preview: clampLine(strings.TrimSpace(line))}
					for j := max(0, i-cx); j < i; j++ {
						hit.Before = append(hit.Before, clampLine(lines[j]))
					}
					for j := i + 1; j <= min(len(lines)-1, i+cx); j++ {
						hit.After = append(hit.After, clampLine(lines[j]))
					}
					out.Hits = append(out.Hits, hit)
					files[wsRel] = true
				}
				return nil
			})
			if walkErr != nil && ctx.Err() == nil {
				return nil, fmt.Errorf("grep: %w", walkErr)
			}

			out.Count = len(out.Hits)
			out.FileCount = len(files)
			if out.Truncated {
				out.Notice = fmt.Sprintf("stopped at %d matches; narrow the pattern or the path", grepMaxMatches)
			}
			if out.Count == 0 {
				out.Notice = "no matches"
			}
			return out, nil
		},
	}
}

func resolveSearchRoot(ws *workspace.Workspace, path string) (string, error) {
	if strings.TrimSpace(path) == "" {
		path = "."
	}
	abs, err := ws.Resolve(path)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(abs)
	if err != nil {
		return "", fmt.Errorf("search root %q: %w", path, err)
	}
	if !info.IsDir() {
		return "", fmt.Errorf("search root %q is not a directory", path)
	}
	return abs, nil
}

// globToRegexp converts a glob into an anchored regexp over slash-separated
// paths. `**` crosses separators, `*` and `?` do not -- the distinction
// people expect from .gitignore and every shell, and the reason
// filepath.Match alone is not enough here.
func globToRegexp(pattern string) (*regexp.Regexp, error) {
	p := filepath.ToSlash(strings.TrimPrefix(pattern, "./"))
	var b strings.Builder
	b.WriteString("^")
	for i := 0; i < len(p); i++ {
		switch p[i] {
		case '*':
			if i+1 < len(p) && p[i+1] == '*' {
				i++
				// "**/" should also match zero directories, so a/**/b
				// matches a/b as well as a/x/y/b.
				if i+1 < len(p) && p[i+1] == '/' {
					i++
					b.WriteString("(?:.*/)?")
				} else {
					b.WriteString(".*")
				}
			} else {
				b.WriteString("[^/]*")
			}
		case '?':
			b.WriteString("[^/]")
		case '.', '+', '(', ')', '|', '^', '$', '{', '}', '[', ']', '\\':
			b.WriteByte('\\')
			b.WriteByte(p[i])
		default:
			b.WriteByte(p[i])
		}
	}
	b.WriteString("$")
	return regexp.Compile(b.String())
}

func clampLine(s string) string {
	if len(s) <= grepPreviewMaxLen {
		return s
	}
	return s[:grepPreviewMaxLen] + "…"
}
