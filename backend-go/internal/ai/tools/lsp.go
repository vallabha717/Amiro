package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"

	"amiro/backend/internal/agent/lsp"
	"amiro/backend/internal/agent/workspace"
)

// maxLSPResults bounds a result set. `references` on a widely-used symbol
// legitimately returns thousands; the useful answer to "what calls this"
// is the first page plus an honest count, not the whole set.
const maxLSPResults = 60

// LSPHit is one location, rendered for a reader rather than a protocol.
type LSPHit struct {
	Path string `json:"path"` // workspace-relative
	Line int    `json:"line"` // 1-based, matching every other tool here
	Text string `json:"text,omitempty"`
}

// LSPProblem is one diagnostic.
type LSPProblem struct {
	Path     string `json:"path"`
	Line     int    `json:"line"`
	Severity string `json:"severity"`
	Message  string `json:"message"`
	Source   string `json:"source,omitempty"`
}

// LSPOutput is the tool result across all four operations. One shape, with
// the irrelevant fields omitted, because the alternative is four result
// types the presenter has to switch over for no gain.
type LSPOutput struct {
	Operation string       `json:"operation"`
	Symbol    string       `json:"symbol,omitempty"`
	Path      string       `json:"path,omitempty"`
	Hits      []LSPHit     `json:"hits,omitempty"`
	Problems  []LSPProblem `json:"problems,omitempty"`
	Total     int          `json:"total"`
	Truncated bool         `json:"truncated,omitempty"`
	Notice    string       `json:"notice,omitempty"`
}

type lspInput struct {
	Operation string `json:"operation"`
	Path      string `json:"path"`
	Symbol    string `json:"symbol"`
	Line      int    `json:"line"`
}

func lspTool(pool *lsp.Pool, ws *workspace.Workspace) (Definition, bool) {
	if pool == nil || ws == nil {
		return Definition{}, false
	}
	langs := strings.Join(pool.Languages(), ", ")

	return Definition{
		Name:    NameLSP,
		Toolkit: ToolkitFile,
		Risk:    RiskRead,
		Description: "Ask a language server about a symbol: exactly where it is defined, exactly what " +
			"references it, or what errors a file currently has. Available for " + langs + " here. " +
			"Prefer this over grep when the question is about a *symbol* rather than a string -- grep " +
			"on a name like `New` or `Run` returns every unrelated one too. Use `diagnostics` after " +
			"editing to check a file compiles without running a build. The first call may take a few " +
			"seconds while the server indexes.",
		ParametersSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"operation": {
					"type": "string",
					"enum": ["definition", "references", "symbols", "diagnostics"],
					"description": "definition: where a symbol is declared. references: everything that uses it. symbols: what a file declares. diagnostics: current errors in a file."
				},
				"path": {"type": "string", "description": "File to ask about, relative to the workspace root."},
				"symbol": {"type": "string", "description": "Symbol name, for definition and references. Its first occurrence in the file is used."},
				"line": {"type": "integer", "description": "1-based line to use instead of the symbol name, when that name appears more than once in the file."}
			},
			"required": ["operation", "path"],
			"additionalProperties": false
		}`),
		Execute: func(ctx context.Context, raw json.RawMessage) (any, error) {
			var in lspInput
			if err := json.Unmarshal(raw, &in); err != nil {
				return nil, fmt.Errorf("lsp: %w", err)
			}
			abs, err := ws.Resolve(in.Path)
			if err != nil {
				return nil, err
			}

			server, err := pool.For(ctx, abs)
			if err != nil {
				return nil, fmt.Errorf("lsp: no language server for %s: %w", in.Path, err)
			}
			if server == nil {
				return nil, fmt.Errorf("lsp: no language server available for %s -- use grep or repo_map instead", in.Path)
			}

			switch in.Operation {
			case "symbols":
				return lspSymbols(ctx, server, ws, abs, in.Path)
			case "diagnostics":
				return lspDiagnostics(ctx, server, ws, abs, in.Path)
			case "definition", "references":
				return lspAtSymbol(ctx, server, ws, abs, in)
			default:
				return nil, fmt.Errorf("lsp: unknown operation %q; expected definition, references, symbols or diagnostics", in.Operation)
			}
		},
	}, true
}

func lspAtSymbol(ctx context.Context, server *lsp.Server, ws *workspace.Workspace, abs string, in lspInput) (any, error) {
	src, err := os.ReadFile(abs)
	if err != nil {
		return nil, fmt.Errorf("lsp: %w", err)
	}
	pos, err := locate(string(src), in.Symbol, in.Line)
	if err != nil {
		return nil, err
	}

	var locs []lsp.Location
	if in.Operation == "definition" {
		locs, err = server.Definition(ctx, abs, pos)
	} else {
		// Declaration excluded: the agent asked "what uses this", and
		// including the declaration means the answer to "is this dead code"
		// is always at least one.
		locs, err = server.References(ctx, abs, pos, false)
	}
	if err != nil {
		return nil, fmt.Errorf("lsp %s: %w", in.Operation, err)
	}

	out := LSPOutput{Operation: in.Operation, Symbol: in.Symbol, Path: in.Path, Total: len(locs)}
	if len(locs) == 0 {
		if in.Operation == "references" {
			out.Notice = "no references found -- either nothing uses this, or the server has not finished indexing"
		} else {
			out.Notice = "no definition found; the symbol may be from a dependency the server has not resolved"
		}
		return out, nil
	}

	trimmed := locs
	if len(trimmed) > maxLSPResults {
		trimmed = trimmed[:maxLSPResults]
		out.Truncated = true
	}
	out.Hits = renderHits(ws, trimmed)
	return out, nil
}

func lspSymbols(ctx context.Context, server *lsp.Server, ws *workspace.Workspace, abs, rel string) (any, error) {
	syms, err := server.Symbols(ctx, abs)
	if err != nil {
		return nil, fmt.Errorf("lsp symbols: %w", err)
	}
	var hits []LSPHit
	var walk func(list []lsp.DocumentSymbol, prefix string)
	walk = func(list []lsp.DocumentSymbol, prefix string) {
		for _, s := range list {
			name := s.Name
			if prefix != "" {
				name = prefix + "." + name
			}
			hits = append(hits, LSPHit{Path: rel, Line: s.Selection.Start.Line + 1, Text: name})
			walk(s.Children, name)
		}
	}
	walk(syms, "")

	out := LSPOutput{Operation: "symbols", Path: rel, Total: len(hits)}
	if len(hits) > maxLSPResults {
		hits = hits[:maxLSPResults]
		out.Truncated = true
	}
	out.Hits = hits
	return out, nil
}

func lspDiagnostics(ctx context.Context, server *lsp.Server, ws *workspace.Workspace, abs, rel string) (any, error) {
	// Always refresh: this is called right after an edit, and diagnostics
	// cached from before it describe a file that no longer exists.
	server.Refresh(abs)

	diags, received, err := server.Diagnostics(ctx, abs)
	if err != nil {
		return nil, fmt.Errorf("lsp diagnostics: %w", err)
	}

	out := LSPOutput{Operation: "diagnostics", Path: rel, Total: len(diags)}
	if !received {
		// The distinction that makes this tool trustworthy. "Clean" and
		// "not analysed yet" are the same empty list on the wire and
		// opposite answers to the question being asked.
		out.Notice = "the language server did not report on this file in time -- this is NOT a clean bill of health, retry or run the build"
		return out, nil
	}
	for _, d := range diags {
		out.Problems = append(out.Problems, LSPProblem{
			Path: rel, Line: d.Range.Start.Line + 1,
			Severity: severityName(d.Severity), Message: d.Message, Source: d.Source,
		})
	}
	sort.SliceStable(out.Problems, func(a, b int) bool { return out.Problems[a].Line < out.Problems[b].Line })
	if len(out.Problems) == 0 {
		out.Notice = "no problems reported"
	}
	return out, nil
}

func renderHits(ws *workspace.Workspace, locs []lsp.Location) []LSPHit {
	// One read per distinct file, not one per hit: `references` on a hot
	// symbol returns dozens of hits in the same file.
	cache := map[string][]string{}
	out := make([]LSPHit, 0, len(locs))
	for _, l := range locs {
		abs := lsp.URIToPath(l.URI)
		rel, err := ws.Rel(abs)
		if err != nil {
			// Outside the workspace: a definition in the standard library
			// or a dependency. Still worth reporting -- "it is not in your
			// code" is the answer -- but as an absolute path, since a
			// relative one would be a lie about where it lives.
			rel = abs
		}
		lines, ok := cache[abs]
		if !ok {
			if src, err := os.ReadFile(abs); err == nil {
				lines = strings.Split(string(src), "\n")
			}
			cache[abs] = lines
		}
		text := ""
		if n := l.Range.Start.Line; n >= 0 && n < len(lines) {
			text = strings.TrimSpace(lines[n])
			if len(text) > 200 {
				text = text[:200] + "..."
			}
		}
		out = append(out, LSPHit{Path: rel, Line: l.Range.Start.Line + 1, Text: text})
	}
	return out
}

// locate turns a symbol name (or a 1-based line) into an LSP position.
//
// The model gives a name, not a line and column, because a name is what it
// knows and a column is what it would have to count. The first occurrence
// is used; `line` narrows it when a file mentions the name more than once
// and the first is the wrong one.
func locate(src, symbol string, line int) (lsp.Position, error) {
	lines := strings.Split(src, "\n")

	if line > 0 {
		if line > len(lines) {
			return lsp.Position{}, fmt.Errorf("lsp: line %d is past the end of the file (%d lines)", line, len(lines))
		}
		col := 0
		if symbol != "" {
			if idx := strings.Index(lines[line-1], symbol); idx >= 0 {
				col = idx
			}
		}
		return lsp.Position{Line: line - 1, Character: col}, nil
	}

	if strings.TrimSpace(symbol) == "" {
		return lsp.Position{}, fmt.Errorf("lsp: either `symbol` or `line` is required for this operation")
	}
	for i, l := range lines {
		idx := indexWord(l, symbol)
		if idx >= 0 {
			return lsp.Position{Line: i, Character: idx}, nil
		}
	}
	return lsp.Position{}, fmt.Errorf("lsp: %q does not appear in this file", symbol)
}

// indexWord finds symbol as a whole word, so looking up `New` does not
// land inside `NewHandler` and ask the server about the wrong thing.
func indexWord(line, symbol string) int {
	from := 0
	for {
		idx := strings.Index(line[from:], symbol)
		if idx < 0 {
			return -1
		}
		at := from + idx
		beforeOK := at == 0 || !isIdentChar(line[at-1])
		end := at + len(symbol)
		afterOK := end >= len(line) || !isIdentChar(line[end])
		if beforeOK && afterOK {
			return at
		}
		from = at + len(symbol)
		if from >= len(line) {
			return -1
		}
	}
}

func isIdentChar(c byte) bool {
	return c == '_' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
}

func severityName(s int) string {
	switch s {
	case 1:
		return "error"
	case 2:
		return "warning"
	case 3:
		return "info"
	case 4:
		return "hint"
	default:
		return "unknown"
	}
}
