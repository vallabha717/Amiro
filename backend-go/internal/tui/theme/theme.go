// Package theme holds the TUI's adaptive colors -- one definition per role,
// read by every page, so light and dark terminals (and NO_COLOR) are a
// property of this package and not a choice each component makes for
// itself.
package theme

import "github.com/charmbracelet/lipgloss"

// Theme is a small, named palette. Phase 2 adds tool cards, diffs, reasoning
// and a todo panel, so every one of those gets its own named color rather
// than borrowing System/Muted for everything -- a diff that colors adds and
// removes the same shade of gray is not a diff.
type Theme struct {
	User      lipgloss.Style
	Assistant lipgloss.Style
	System    lipgloss.Style
	Error     lipgloss.Style
	Muted     lipgloss.Style

	// Reasoning renders a model's thinking blocks -- deliberately styled
	// like an aside (dim, italic where the terminal honors it; lipgloss
	// degrades Italic to no-op rather than mojibake on terminals that
	// don't) so it reads as *process*, not as the answer.
	Reasoning lipgloss.Style

	// Tool card chrome: border color per outcome, and the label text next
	// to it. Pending/Done/Error/Interrupted mirror session.ToolStatus
	// exactly -- one style per status, not derived, so a fifth status
	// added later is a compile error here until it gets one too.
	ToolBorderPending     lipgloss.Style
	ToolBorderDone        lipgloss.Style
	ToolBorderError       lipgloss.Style
	ToolBorderInterrupted lipgloss.Style
	ToolTitle             lipgloss.Style

	// Diff coloring, the one place this palette needs more than
	// foreground text -- an added line reads as added because of its
	// background, the way every diff viewer renders it, not just its text
	// color (which alone is too easy to miss at a glance).
	DiffAdd     lipgloss.Style
	DiffRemove  lipgloss.Style
	DiffContext lipgloss.Style

	// Todo panel glyphs -- ASCII on purpose ([x]/[~]/[ ]), not Unicode
	// checkboxes: a terminal with a narrow or missing glyph set (SSH into
	// a minimal container, tmux with a stale terminfo) renders a missing
	// glyph as a mangled cell, and a todo list is exactly the place a
	// reader is trying to scan quickly, not decode.
	TodoDone       lipgloss.Style
	TodoInProgress lipgloss.Style
	TodoPending    lipgloss.Style

	// StatusBar is the one-line model/mode/workspace/tokens/cost/elapsed
	// strip -- its own style because it sits directly under the composer,
	// not the transcript, and needs to read as chrome, not content.
	StatusBar lipgloss.Style

	// Approval is the dialog's border/title color -- the same amber family
	// as ToolBorderPending (a suspended call is a kind of pending call) but
	// its own named style: the dialog is a prompt the user must act on, not
	// passive status, and a future palette change to "pending" should not
	// have to remember this depends on it too.
	Approval lipgloss.Style
}

// Default is adaptive light/dark, per lipgloss.AdaptiveColor -- it reads the
// terminal's background itself, so this needs no NO_COLOR special-casing:
// lipgloss already turns off color rendering when NO_COLOR is set or the
// output isn't a terminal.
var Default = Theme{
	User: lipgloss.NewStyle().
		Foreground(lipgloss.AdaptiveColor{Light: "#0057B7", Dark: "#5AA9FF"}).
		Bold(true),
	Assistant: lipgloss.NewStyle().
		Foreground(lipgloss.AdaptiveColor{Light: "#166534", Dark: "#6EE7A8"}).
		Bold(true),
	System: lipgloss.NewStyle().
		Foreground(lipgloss.AdaptiveColor{Light: "#6B7280", Dark: "#9CA3AF"}),
	Error: lipgloss.NewStyle().
		Foreground(lipgloss.AdaptiveColor{Light: "#B91C1C", Dark: "#F87171"}).
		Bold(true),
	Muted: lipgloss.NewStyle().
		Foreground(lipgloss.AdaptiveColor{Light: "#9CA3AF", Dark: "#6B7280"}),

	Reasoning: lipgloss.NewStyle().
		Foreground(lipgloss.AdaptiveColor{Light: "#9CA3AF", Dark: "#6B7280"}).
		Italic(true),

	ToolBorderPending: lipgloss.NewStyle().
		Foreground(lipgloss.AdaptiveColor{Light: "#B45309", Dark: "#FBBF24"}),
	ToolBorderDone: lipgloss.NewStyle().
		Foreground(lipgloss.AdaptiveColor{Light: "#D1D5DB", Dark: "#374151"}),
	ToolBorderError: lipgloss.NewStyle().
		Foreground(lipgloss.AdaptiveColor{Light: "#B91C1C", Dark: "#F87171"}),
	ToolBorderInterrupted: lipgloss.NewStyle().
		Foreground(lipgloss.AdaptiveColor{Light: "#B45309", Dark: "#FBBF24"}),
	ToolTitle: lipgloss.NewStyle().Bold(true),

	DiffAdd: lipgloss.NewStyle().
		Foreground(lipgloss.AdaptiveColor{Light: "#166534", Dark: "#6EE7A8"}),
	DiffRemove: lipgloss.NewStyle().
		Foreground(lipgloss.AdaptiveColor{Light: "#B91C1C", Dark: "#F87171"}),
	DiffContext: lipgloss.NewStyle().
		Foreground(lipgloss.AdaptiveColor{Light: "#6B7280", Dark: "#9CA3AF"}),

	TodoDone: lipgloss.NewStyle().
		Foreground(lipgloss.AdaptiveColor{Light: "#166534", Dark: "#6EE7A8"}),
	TodoInProgress: lipgloss.NewStyle().
		Foreground(lipgloss.AdaptiveColor{Light: "#B45309", Dark: "#FBBF24"}).
		Bold(true),
	TodoPending: lipgloss.NewStyle().
		Foreground(lipgloss.AdaptiveColor{Light: "#6B7280", Dark: "#9CA3AF"}),

	StatusBar: lipgloss.NewStyle().
		Foreground(lipgloss.AdaptiveColor{Light: "#6B7280", Dark: "#9CA3AF"}),

	Approval: lipgloss.NewStyle().
		Foreground(lipgloss.AdaptiveColor{Light: "#B45309", Dark: "#FBBF24"}).
		Bold(true),
}
