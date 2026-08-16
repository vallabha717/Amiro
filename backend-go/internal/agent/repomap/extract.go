package repomap

import (
	"go/ast"
	"go/parser"
	"go/token"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// maxSymbolsPerFile keeps one generated or enormous file from filling the
// whole map. Files near this cap are almost always machine-written, and
// the symbols past it are the ones nothing else references anyway --
// Build's per-symbol reference ordering runs after this, so the cut is by
// declaration order, but a file with 300 declarations is not a file the
// reader is going to navigate by name regardless.
const maxSymbolsPerFile = 300

// languageOf maps a path to an extractor key, or "" for files the map
// should not describe.
//
// Extension-based, and that is a real limit: an extensionless executable
// script with a `#!/usr/bin/env python` line is invisible here. Sniffing
// shebangs would mean opening every extensionless file in the repo to find
// the handful that are scripts.
func languageOf(rel string) string {
	switch strings.ToLower(path.Ext(rel)) {
	case ".go":
		return "go"
	case ".ts", ".tsx", ".mts", ".cts":
		return "ts"
	case ".js", ".jsx", ".mjs", ".cjs":
		return "js"
	case ".py", ".pyi":
		return "python"
	case ".rs":
		return "rust"
	case ".java":
		return "java"
	case ".kt", ".kts":
		return "kotlin"
	case ".rb":
		return "ruby"
	case ".c", ".h":
		return "c"
	case ".cc", ".cpp", ".cxx", ".hpp", ".hh":
		return "cpp"
	case ".cs":
		return "csharp"
	case ".swift":
		return "swift"
	case ".php":
		return "php"
	default:
		return ""
	}
}

func extract(lang, rel string, src []byte) []Symbol {
	var syms []Symbol
	if lang == "go" {
		syms = extractGo(rel, src)
	} else {
		syms = extractByPattern(lang, src)
	}
	if len(syms) > maxSymbolsPerFile {
		syms = syms[:maxSymbolsPerFile]
	}
	return syms
}

// extractGo uses the standard library's parser -- a real AST, free, no cgo.
//
// Falls back to the pattern extractor when the file does not parse. A file
// mid-edit is exactly when an agent most wants a map, so refusing to
// describe it at all is the wrong failure: the patterns still find most of
// its declarations.
func extractGo(rel string, src []byte) []Symbol {
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, rel, src, parser.SkipObjectResolution)
	if err != nil && f == nil {
		return extractByPattern("go", src)
	}

	var out []Symbol
	line := func(p token.Pos) int { return fset.Position(p).Line }

	for _, decl := range f.Decls {
		switch d := decl.(type) {
		case *ast.FuncDecl:
			if d.Name == nil {
				continue
			}
			kind := "func"
			name := d.Name.Name
			if d.Recv != nil && len(d.Recv.List) > 0 {
				kind = "method"
				// Qualified with the receiver: `Writer.Flush` is what a
				// reader is looking for, and an unqualified `Flush` in a
				// list of 40 methods says nothing about what it is on.
				if recv := receiverName(d.Recv.List[0].Type); recv != "" {
					name = recv + "." + name
				}
			}
			out = append(out, Symbol{Name: name, Kind: kind, Line: line(d.Pos())})

		case *ast.GenDecl:
			for _, spec := range d.Specs {
				switch s := spec.(type) {
				case *ast.TypeSpec:
					out = append(out, Symbol{Name: s.Name.Name, Kind: "type", Line: line(s.Pos())})
				case *ast.ValueSpec:
					kind := "var"
					if d.Tok == token.CONST {
						kind = "const"
					}
					for _, n := range s.Names {
						if n.Name == "_" {
							continue
						}
						out = append(out, Symbol{Name: n.Name, Kind: kind, Line: line(n.Pos())})
					}
				}
			}
		}
	}
	return out
}

func receiverName(expr ast.Expr) string {
	switch t := expr.(type) {
	case *ast.StarExpr:
		return receiverName(t.X)
	case *ast.Ident:
		return t.Name
	case *ast.IndexExpr: // generic receiver: Foo[T]
		return receiverName(t.X)
	case *ast.IndexListExpr:
		return receiverName(t.X)
	}
	return ""
}

// declPattern is one language's way of spelling a declaration.
type declPattern struct {
	re   *regexp.Regexp
	kind string
}

// patterns are anchored at line start (after optional indentation) on
// purpose. An unanchored `func\s+(\w+)` matches the word "func" inside a
// comment or a string, and a map full of phantom symbols is worse than one
// missing a few: a missing entry costs a grep, a phantom one sends the
// reader to a file that does not contain what they were promised.
var patterns = map[string][]declPattern{
	"ts": {
		{regexp.MustCompile(`(?m)^[ \t]*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)`), "class"},
		{regexp.MustCompile(`(?m)^[ \t]*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)`), "interface"},
		{regexp.MustCompile(`(?m)^[ \t]*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)`), "type"},
		{regexp.MustCompile(`(?m)^[ \t]*(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)`), "enum"},
		{regexp.MustCompile(`(?m)^[ \t]*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)`), "func"},
		// `export const useThing = (...) =>` and `const Thing: FC = ...`.
		// Top-level only (no leading whitespace) because indented consts
		// are locals, and a map of locals is noise.
		{regexp.MustCompile(`(?m)^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*(?:async\s*)?(?:\([^\n)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=>`), "func"},
		{regexp.MustCompile(`(?m)^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)`), "const"},
	},
	"python": {
		{regexp.MustCompile(`(?m)^[ \t]*class\s+([A-Za-z_]\w*)`), "class"},
		{regexp.MustCompile(`(?m)^[ \t]*(?:async\s+)?def\s+([A-Za-z_]\w*)`), "func"},
	},
	"rust": {
		{regexp.MustCompile(`(?m)^[ \t]*(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)`), "struct"},
		{regexp.MustCompile(`(?m)^[ \t]*(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_]\w*)`), "enum"},
		{regexp.MustCompile(`(?m)^[ \t]*(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_]\w*)`), "trait"},
		{regexp.MustCompile(`(?m)^[ \t]*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+([A-Za-z_]\w*)`), "func"},
		{regexp.MustCompile(`(?m)^[ \t]*impl(?:<[^>]*>)?\s+(?:[\w:]+\s+for\s+)?([A-Za-z_]\w*)`), "impl"},
	},
	"java": {
		{regexp.MustCompile(`(?m)^[ \t]*(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:final\s+)?(?:abstract\s+)?class\s+([A-Za-z_]\w*)`), "class"},
		{regexp.MustCompile(`(?m)^[ \t]*(?:public\s+|private\s+|protected\s+)?interface\s+([A-Za-z_]\w*)`), "interface"},
		{regexp.MustCompile(`(?m)^[ \t]*(?:public\s+|private\s+|protected\s+)?(?:static\s+)?record\s+([A-Za-z_]\w*)`), "record"},
		{regexp.MustCompile(`(?m)^[ \t]*(?:public\s+|private\s+|protected\s+)?enum\s+([A-Za-z_]\w*)`), "enum"},
	},
	"kotlin": {
		{regexp.MustCompile(`(?m)^[ \t]*(?:\w+\s+)*class\s+([A-Za-z_]\w*)`), "class"},
		{regexp.MustCompile(`(?m)^[ \t]*(?:\w+\s+)*object\s+([A-Za-z_]\w*)`), "object"},
		{regexp.MustCompile(`(?m)^[ \t]*(?:\w+\s+)*interface\s+([A-Za-z_]\w*)`), "interface"},
		{regexp.MustCompile(`(?m)^[ \t]*(?:\w+\s+)*fun\s+(?:<[^>]*>\s*)?([A-Za-z_]\w*)`), "func"},
	},
	"ruby": {
		{regexp.MustCompile(`(?m)^[ \t]*class\s+([A-Z]\w*)`), "class"},
		{regexp.MustCompile(`(?m)^[ \t]*module\s+([A-Z]\w*)`), "module"},
		{regexp.MustCompile(`(?m)^[ \t]*def\s+(?:self\.)?([A-Za-z_]\w*[?!]?)`), "func"},
	},
	"c": {
		{regexp.MustCompile(`(?m)^[A-Za-z_][\w \t*]*\s+\*?([A-Za-z_]\w*)\s*\([^;]*\)\s*\{`), "func"},
		{regexp.MustCompile(`(?m)^typedef\s+struct[^;{]*\{[^}]*\}\s*([A-Za-z_]\w*)\s*;`), "type"},
		{regexp.MustCompile(`(?m)^struct\s+([A-Za-z_]\w*)\s*\{`), "struct"},
	},
	"csharp": {
		{regexp.MustCompile(`(?m)^[ \t]*(?:\w+\s+)*class\s+([A-Za-z_]\w*)`), "class"},
		{regexp.MustCompile(`(?m)^[ \t]*(?:\w+\s+)*interface\s+([A-Za-z_]\w*)`), "interface"},
		{regexp.MustCompile(`(?m)^[ \t]*(?:\w+\s+)*record\s+([A-Za-z_]\w*)`), "record"},
		{regexp.MustCompile(`(?m)^[ \t]*(?:\w+\s+)*struct\s+([A-Za-z_]\w*)`), "struct"},
	},
	"swift": {
		{regexp.MustCompile(`(?m)^[ \t]*(?:\w+\s+)*class\s+([A-Za-z_]\w*)`), "class"},
		{regexp.MustCompile(`(?m)^[ \t]*(?:\w+\s+)*struct\s+([A-Za-z_]\w*)`), "struct"},
		{regexp.MustCompile(`(?m)^[ \t]*(?:\w+\s+)*protocol\s+([A-Za-z_]\w*)`), "protocol"},
		{regexp.MustCompile(`(?m)^[ \t]*(?:\w+\s+)*enum\s+([A-Za-z_]\w*)`), "enum"},
		{regexp.MustCompile(`(?m)^[ \t]*(?:\w+\s+)*func\s+([A-Za-z_]\w*)`), "func"},
	},
	"php": {
		{regexp.MustCompile(`(?m)^[ \t]*(?:abstract\s+|final\s+)?class\s+([A-Za-z_]\w*)`), "class"},
		{regexp.MustCompile(`(?m)^[ \t]*interface\s+([A-Za-z_]\w*)`), "interface"},
		{regexp.MustCompile(`(?m)^[ \t]*trait\s+([A-Za-z_]\w*)`), "trait"},
		{regexp.MustCompile(`(?m)^[ \t]*(?:public\s+|private\s+|protected\s+|static\s+)*function\s+([A-Za-z_]\w*)`), "func"},
	},
}

func init() {
	// JS and TS share a syntax for everything this extractor looks at, and
	// C++ is a superset of C for declaration shapes crude enough to match
	// by line. Aliasing beats two copies that drift.
	patterns["js"] = patterns["ts"]
	patterns["cpp"] = append(append([]declPattern{}, patterns["c"]...), []declPattern{
		{regexp.MustCompile(`(?m)^[ \t]*class\s+([A-Za-z_]\w*)`), "class"},
		{regexp.MustCompile(`(?m)^[ \t]*namespace\s+([A-Za-z_]\w*)`), "namespace"},
	}...)
	// Go's fallback, used only when the file does not parse at all.
	patterns["go"] = []declPattern{
		{regexp.MustCompile(`(?m)^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)`), "func"},
		{regexp.MustCompile(`(?m)^type\s+([A-Za-z_]\w*)`), "type"},
	}
}

func extractByPattern(lang string, src []byte) []Symbol {
	pats, ok := patterns[lang]
	if !ok {
		return nil
	}
	text := string(src)
	lineStarts := newlineIndex(text)

	// Keyed by name+line so two patterns matching the same declaration
	// (`export default class Foo` hits both the class and the default
	// pattern in some languages) produce one symbol, not two.
	seen := map[string]bool{}
	var out []Symbol
	for _, p := range pats {
		for _, m := range p.re.FindAllSubmatchIndex(src, -1) {
			if len(m) < 4 || m[2] < 0 {
				continue
			}
			name := text[m[2]:m[3]]
			line := lineOf(lineStarts, m[2])
			key := name + ":" + strconv.Itoa(line)
			if seen[key] {
				continue
			}
			seen[key] = true
			out = append(out, Symbol{Name: name, Kind: p.kind, Line: line})
		}
	}
	sort.SliceStable(out, func(a, b int) bool { return out[a].Line < out[b].Line })
	return out
}

func newlineIndex(s string) []int {
	starts := []int{0}
	for i := 0; i < len(s); i++ {
		if s[i] == '\n' {
			starts = append(starts, i+1)
		}
	}
	return starts
}

// lineOf binary-searches the newline index. Linear scanning per match is
// O(matches x filesize), which on a 300-symbol file is measurably slow.
func lineOf(starts []int, offset int) int {
	lo, hi := 0, len(starts)-1
	for lo < hi {
		mid := (lo + hi + 1) / 2
		if starts[mid] <= offset {
			lo = mid
		} else {
			hi = mid - 1
		}
	}
	return lo + 1
}
