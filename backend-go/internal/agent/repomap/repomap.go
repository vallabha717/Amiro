// Package repomap builds an Aider-style repository map: a ranked, budgeted
// outline of the symbols a codebase defines and where they live.
//
// It exists to answer the question an agent asks first and has the worst
// tools for -- "what is in this repo, and where do I start?" Without it the
// opening move on an unfamiliar codebase is a scattershot of `list_dir` and
// `grep`, each costing a round trip and returning either too little to
// orient by or a directory listing of 4,000 files.
//
// # Why not tree-sitter
//
// Aider uses tree-sitter, and so does every other implementation of this
// idea. Every Go binding for it is cgo, and this ships as a cross-compiled
// desktop binary across six installer formats (.deb/.rpm/.AppImage/.dmg/
// .msi/.exe). Turning cgo on is a packaging decision, not a tooling one --
// the same trade internal/ai/tools/search.go already made deliberately when
// it chose Go/RE2 over shelling out to ripgrep.
//
// So: Go is parsed with go/parser, a real AST from the standard library,
// and every other language with line-oriented patterns (extract.go). The
// honest description of the difference is that the patterns find
// *declarations*, not a parse tree. They miss symbols declared in shapes
// the patterns do not cover, and they cannot tell a commented-out function
// from a real one.
//
// That is an acceptable trade *for this specific artifact* and would not be
// for most others. A map is a navigation aid whose next step is always
// reading the actual file -- a missing entry costs one extra grep, and a
// spurious one costs one wasted read. Compare edit_file's syntax gate,
// which refuses to write on a parse failure: there, a wrong answer corrupts
// the user's file, which is why that gate only covers the two languages
// with real parsers in the standard library (edit.go's checkSyntax).
// Precision is worth paying for where being wrong is expensive and not
// where it is cheap.
package repomap

import (
	"context"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode"
)

// Symbol is one declaration found in a file.
type Symbol struct {
	Name string `json:"name"`
	Kind string `json:"kind"` // func, type, method, class, const, var...
	Line int    `json:"line"`

	// refs is how many *other* files mention this name. It orders symbols
	// within a file when the budget forces a cut, so what survives
	// truncation is what the rest of the repo actually calls.
	refs int
}

// File is one source file's contribution to the map.
type File struct {
	Path    string   `json:"path"` // workspace-relative, always slash-separated
	Lang    string   `json:"lang"`
	Symbols []Symbol `json:"symbols"`
	Rank    float64  `json:"rank"`
}

// Map is the built repository map, ranked but not yet rendered.
type Map struct {
	Files []File `json:"files"`

	// Scanned counts files actually parsed; Skipped counts those walked
	// past (binary, oversized, unknown extension). Both are reported to the
	// model, because "37 files" and "37 files, 1,200 skipped" describe very
	// different repositories and it must not read the first as the second.
	Scanned int `json:"scanned"`
	Skipped int `json:"skipped"`

	// Partial means the walk stopped at MaxFiles rather than finishing.
	Partial bool `json:"partial"`
}

// Options configures a build.
type Options struct {
	// Root is the absolute directory to walk. Containment is the caller's
	// job -- this package is handed a directory and reads it. The tool
	// wrapper resolves through workspace.Resolve first.
	Root string

	// Skip decides which paths the walk ignores, taking a slash-separated
	// path relative to Root. Injected rather than reimplemented so the tool
	// can pass the same .gitignore-aware matcher list_dir uses; nil skips
	// nothing but the always-ignored set below.
	Skip func(rel string, isDir bool) bool

	// Focus biases ranking toward files whose path contains any of these
	// substrings, and toward files defining a symbol named in them. This is
	// what makes "map me the auth code" different from "map me the repo":
	// the ranking is personalized, exactly as Aider personalizes PageRank
	// toward the files already in the chat.
	Focus []string

	// MaxFiles bounds the walk. Zero means defaultMaxFiles.
	MaxFiles int

	// MaxFileBytes skips files larger than this. Zero means
	// defaultMaxFileBytes. Generated bundles and vendored blobs are the
	// target: they are enormous, define thousands of symbols, and rank
	// highly for exactly the wrong reason.
	MaxFileBytes int
}

const (
	defaultMaxFiles     = 4000
	defaultMaxFileBytes = 512 * 1024

	// pagerankIterations is well past convergence for graphs this size and
	// still costs microseconds; there is no reason to detect convergence.
	pagerankIterations = 24
	damping            = 0.85
)

// alwaysSkipped are directories no repository map should ever describe:
// dependency trees and build output. They are other people's code, or this
// code compiled, and either way they crowd out the thing being mapped.
var alwaysSkipped = map[string]bool{
	".git": true, "node_modules": true, ".next": true, "dist": true,
	"build": true, "target": true, "vendor": true, ".venv": true,
	"__pycache__": true, ".turbo": true, "coverage": true, ".cache": true,
}

// Build walks Root, extracts declarations, and ranks the files.
func Build(ctx context.Context, opts Options) (*Map, error) {
	if opts.MaxFiles <= 0 {
		opts.MaxFiles = defaultMaxFiles
	}
	if opts.MaxFileBytes <= 0 {
		opts.MaxFileBytes = defaultMaxFileBytes
	}

	var files []parsedFile
	skipped := 0
	partial := false

	err := filepath.WalkDir(opts.Root, func(abs string, d fs.DirEntry, err error) error {
		if err != nil {
			// An unreadable directory is not a reason to fail the whole
			// map. Orientation on 90% of a repo beats an error.
			if d != nil && d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}

		rel, relErr := filepath.Rel(opts.Root, abs)
		if relErr != nil {
			return nil
		}
		rel = filepath.ToSlash(rel)
		if rel == "." {
			return nil
		}

		if d.IsDir() {
			if alwaysSkipped[d.Name()] || strings.HasPrefix(d.Name(), ".") && d.Name() != "." {
				return fs.SkipDir
			}
			if opts.Skip != nil && opts.Skip(rel, true) {
				return fs.SkipDir
			}
			return nil
		}

		if len(files) >= opts.MaxFiles {
			partial = true
			return fs.SkipAll
		}

		lang := languageOf(rel)
		if lang == "" {
			skipped++
			return nil
		}
		if opts.Skip != nil && opts.Skip(rel, false) {
			skipped++
			return nil
		}
		if info, statErr := d.Info(); statErr == nil && info.Size() > int64(opts.MaxFileBytes) {
			skipped++
			return nil
		}

		src, readErr := os.ReadFile(abs)
		if readErr != nil {
			skipped++
			return nil
		}

		syms := extract(lang, rel, src)
		if len(syms) == 0 {
			// Still counted as scanned, but a file with no declarations
			// contributes nothing to a map of declarations.
			skipped++
			return nil
		}
		files = append(files, parsedFile{
			file:   File{Path: rel, Lang: lang, Symbols: syms},
			tokens: tokenize(src),
		})
		return nil
	})
	if err != nil && ctx.Err() != nil {
		return nil, ctx.Err()
	}

	// definers: symbol name -> indices of files declaring it. Names
	// declared in many files (`New`, `String`, `main`) carry almost no
	// information about *where* to look, so they are weighted down rather
	// than dropped -- dropping them would erase real edges in a codebase
	// that leans on interfaces.
	definers := map[string][]int{}
	for i, p := range files {
		for _, s := range p.file.Symbols {
			definers[s.Name] = append(definers[s.Name], i)
		}
	}

	ranks := pagerank(files2edges(files, definers), len(files), focusWeights(files, opts.Focus))

	// Test files are demoted, not excluded.
	//
	// They rank high on the raw graph -- a test file references the code it
	// tests heavily and is itself referenced by nothing -- and a map that
	// opens with four _test.go files has answered "what is this repo about"
	// with "testing". Excluding them would be wrong in the other direction:
	// "where are the tests for the permission engine" is a real question,
	// and a map that cannot answer it sends the agent back to grep.
	for i := range files {
		if isTestFile(files[i].file.Path) {
			ranks[i] *= testFileWeight
		}
	}

	// Count external references per symbol, for intra-file ordering.
	refCount := map[string]int{}
	for i, p := range files {
		for tok := range p.tokens {
			if owners, ok := definers[tok]; ok {
				for _, owner := range owners {
					if owner != i {
						refCount[tok] += p.tokens[tok]
						break
					}
				}
			}
		}
	}

	out := &Map{Scanned: len(files), Skipped: skipped, Partial: partial}
	for i := range files {
		f := files[i].file
		f.Rank = ranks[i]
		for j := range f.Symbols {
			f.Symbols[j].refs = refCount[f.Symbols[j].Name]
		}
		sort.SliceStable(f.Symbols, func(a, b int) bool {
			if f.Symbols[a].refs != f.Symbols[b].refs {
				return f.Symbols[a].refs > f.Symbols[b].refs
			}
			return f.Symbols[a].Line < f.Symbols[b].Line
		})
		out.Files = append(out.Files, f)
	}
	sort.SliceStable(out.Files, func(a, b int) bool {
		if out.Files[a].Rank != out.Files[b].Rank {
			return out.Files[a].Rank > out.Files[b].Rank
		}
		return out.Files[a].Path < out.Files[b].Path
	})
	return out, nil
}

// parsedFile pairs a file's extracted declarations with every identifier
// appearing in it, which is all the ranking below needs.
type parsedFile struct {
	file   File
	tokens map[string]int
}

// edge is a weighted reference from one file to another.
type edge struct {
	from, to int
	weight   float64
}

func files2edges(files []parsedFile, definers map[string][]int) []edge {
	var edges []edge
	for i, p := range files {
		for tok, n := range p.tokens {
			owners, ok := definers[tok]
			if !ok {
				continue
			}
			// A name defined in 50 files is a naming convention, not a
			// dependency. Splitting the weight across definers means such
			// names still connect the graph but cannot dominate it.
			w := float64(n) / float64(len(owners))
			for _, owner := range owners {
				if owner == i {
					continue
				}
				edges = append(edges, edge{from: i, to: owner, weight: w})
			}
		}
	}
	return edges
}

// focusWeights turns Options.Focus into a personalization vector.
//
// Uniform personalization is the standard PageRank; a biased vector is what
// makes the result answer "what matters *for this question*" instead of
// "what matters in general". A repo's globally-highest-ranked file is
// usually something like a shared types package, which is true and useless
// when the user asked about authentication.
func focusWeights(files []parsedFile, focus []string) []float64 {
	n := len(files)
	if n == 0 {
		return nil
	}
	w := make([]float64, n)
	if len(focus) == 0 {
		for i := range w {
			w[i] = 1 / float64(n)
		}
		return w
	}

	lower := make([]string, len(focus))
	for i, f := range focus {
		lower[i] = strings.ToLower(f)
	}

	total := 0.0
	for i, p := range files {
		score := 0.1 // never zero: an unfocused file may still be reachable
		path := strings.ToLower(p.file.Path)
		for _, f := range lower {
			if f == "" {
				continue
			}
			if strings.Contains(path, f) {
				score += 3
			}
			for _, s := range p.file.Symbols {
				if strings.Contains(strings.ToLower(s.Name), f) {
					score += 1
					break
				}
			}
		}
		w[i] = score
		total += score
	}
	for i := range w {
		w[i] /= total
	}
	return w
}

// pagerank ranks files by how much of the repo's attention flows to them.
//
// A plain reference count answers "how many files mention this?", which
// over-rewards utility modules everything touches shallowly. PageRank
// answers "how much do the files that matter depend on this?", which is the
// question a newcomer to a codebase is actually asking. It is also what
// Aider uses, for the same reason.
func pagerank(edges []edge, n int, personalization []float64) []float64 {
	if n == 0 {
		return nil
	}
	if personalization == nil {
		personalization = make([]float64, n)
		for i := range personalization {
			personalization[i] = 1 / float64(n)
		}
	}

	outWeight := make([]float64, n)
	for _, e := range edges {
		outWeight[e.from] += e.weight
	}

	rank := make([]float64, n)
	copy(rank, personalization)
	next := make([]float64, n)

	for iter := 0; iter < pagerankIterations; iter++ {
		// Dangling mass: a file that references nothing would otherwise
		// leak its rank out of the system every iteration, and the totals
		// would drift toward zero instead of staying a distribution.
		dangling := 0.0
		for i := 0; i < n; i++ {
			if outWeight[i] == 0 {
				dangling += rank[i]
			}
			next[i] = 0
		}
		for _, e := range edges {
			next[e.to] += rank[e.from] * e.weight / outWeight[e.from]
		}
		for i := 0; i < n; i++ {
			next[i] = (1-damping)*personalization[i] +
				damping*(next[i]+dangling*personalization[i])
		}
		copy(rank, next)
	}
	return rank
}

// testFileWeight is how much a test file's rank is scaled by. Enough to
// keep them out of the opening screen of a mixed repository, not so much
// that a focused query about testing cannot surface them.
const testFileWeight = 0.25

// isTestFile recognises the conventions of the languages this maps.
// Pattern-based like everything else here, and wrong in the same cheap
// direction: a misidentified file is ranked slightly low, not omitted.
func isTestFile(path string) bool {
	base := path
	if i := strings.LastIndex(path, "/"); i >= 0 {
		base = path[i+1:]
	}
	lower := strings.ToLower(base)
	switch {
	case strings.HasSuffix(lower, "_test.go"), // Go
		strings.HasSuffix(lower, "_test.py"), strings.HasPrefix(lower, "test_"), // Python
		strings.Contains(lower, ".test."), strings.Contains(lower, ".spec."): // JS/TS
		return true
	}
	// Directory conventions: __tests__/, spec/, test/, tests/.
	for _, seg := range strings.Split(path, "/") {
		switch strings.ToLower(seg) {
		case "__tests__", "spec", "test", "tests", "testdata":
			return true
		}
	}
	return false
}

// tokenize collects identifier-ish words and how often each appears.
//
// Deliberately crude: it does not know comments from code, or a string
// literal from an expression. Both would need a real parser per language,
// which is the cost this package exists to avoid, and both fail in the
// direction of a slightly noisier ranking rather than a wrong map.
func tokenize(src []byte) map[string]int {
	out := map[string]int{}
	start := -1
	for i := 0; i <= len(src); i++ {
		var c byte
		if i < len(src) {
			c = src[i]
		}
		isWord := i < len(src) && (c == '_' ||
			unicode.IsLetter(rune(c)) || unicode.IsDigit(rune(c)))
		switch {
		case isWord && start < 0:
			start = i
		case !isWord && start >= 0:
			// Two characters is below the length at which a name carries
			// information; `i`, `n`, `id` as edges would connect everything
			// to everything.
			if i-start > 2 {
				out[string(src[start:i])]++
			}
			start = -1
		}
	}
	return out
}
