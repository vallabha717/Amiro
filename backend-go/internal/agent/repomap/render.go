package repomap

import (
	"fmt"
	"sort"
	"strings"
)

// DefaultBudget is roughly 4k tokens at the chars/4 heuristic
// internal/agent/compaction uses. Aider defaults to about 1k and rebuilds
// the map every turn; this tool is called explicitly and its result stays
// in the history, so it can afford more -- but it is competing with the
// same context window compaction is trying to protect, and a map big
// enough to need scrolling has stopped being a map.
const DefaultBudget = 16000

// Render lays the map out as text for the model, cutting to fit budget.
//
// Text, not JSON, and that is deliberate. The reader is a language model
// and this is prose-shaped data: `path/to/file.go` followed by an indented
// list of names costs roughly half the tokens of the same content wrapped
// in quotes, braces and repeated key names. The structured form is still
// available on the tool result for the presenter to render from -- the two
// have different readers with different needs, which is the whole reason
// they are separate.
func (m *Map) Render(budget int) string {
	if budget <= 0 {
		budget = DefaultBudget
	}
	if m == nil || len(m.Files) == 0 {
		return "No source files found to map."
	}

	var b strings.Builder
	fmt.Fprintf(&b, "Repository map -- %d files, ranked by how much the rest of the repo depends on them.\n",
		len(m.Files))
	b.WriteString("Symbols are declarations only; read the file for bodies.\n\n")

	// Two passes with a shrinking per-file allowance, rather than one pass
	// that spends the budget in rank order. Rank order alone gives the top
	// file 40 symbols and the tenth none, which reads as "the repo is one
	// file" -- exactly the wrong impression. Every file that made the cut
	// gets its most-referenced symbols first.
	perFile := symbolsPerFile(m.Files, budget)

	shown := 0
	truncated := false
	for _, f := range m.Files {
		entry := renderFile(f, perFile)
		if b.Len()+len(entry) > budget {
			truncated = true
			break
		}
		b.WriteString(entry)
		shown++
	}

	if truncated || m.Partial || m.Skipped > 0 {
		b.WriteString("\n")
	}
	if truncated {
		fmt.Fprintf(&b, "(%d more files omitted to fit the budget -- narrow with `focus` to see them.)\n",
			len(m.Files)-shown)
	}
	if m.Partial {
		fmt.Fprintf(&b, "(The walk stopped at its file limit; this repository is larger than the map.)\n")
	}
	if m.Skipped > 0 {
		fmt.Fprintf(&b, "(%d files skipped: unsupported language, too large, or no declarations.)\n", m.Skipped)
	}
	return b.String()
}

// symbolsPerFile picks a per-file symbol allowance that lets roughly the
// top half of the files fit. It is an estimate that Render then enforces
// exactly, so getting it slightly wrong costs a few files off the end
// rather than a broken layout.
func symbolsPerFile(files []File, budget int) int {
	if len(files) == 0 {
		return 0
	}
	const avgSymbolChars = 24
	target := len(files)
	if target > 60 {
		target = 60
	}
	per := budget / (target * avgSymbolChars)
	switch {
	case per < 4:
		return 4 // below this a file entry says nothing at all
	case per > 30:
		return 30
	default:
		return per
	}
}

func renderFile(f File, perFile int) string {
	var b strings.Builder
	b.WriteString(f.Path)
	b.WriteString("\n")

	syms := f.Symbols
	extra := 0
	if len(syms) > perFile {
		extra = len(syms) - perFile
		syms = syms[:perFile]
	}

	// Symbols arrive ordered by reference count (Build), which is right for
	// deciding *which* survive and wrong for reading: a list jumping around
	// the file is harder to scan than one that follows it. So: cut by
	// importance, then display in source order.
	display := append([]Symbol(nil), syms...)
	sort.SliceStable(display, func(a, b int) bool { return display[a].Line < display[b].Line })

	for _, s := range display {
		fmt.Fprintf(&b, "  %s %s:%d\n", s.Kind, s.Name, s.Line)
	}
	if extra > 0 {
		fmt.Fprintf(&b, "  ... %d more\n", extra)
	}
	b.WriteString("\n")
	return b.String()
}
