// Package editor holds composer behavior that sits on top of
// bubbles/textarea -- Phase 3's slash-command palette (plan §3's Part 4:
// "the composer needs a /-triggered command palette"). It has no tea.Model
// of its own; page.Chat still owns the textarea and its Update loop, and
// calls into this package for the parts that are the same regardless of
// which page embeds a composer.
package editor

import (
	"strings"

	"github.com/charmbracelet/lipgloss"

	"amiro/backend/internal/tui/theme"
)

// SlashCommand is one entry in the palette.
type SlashCommand struct {
	Name string // typed after "/", e.g. "mode"
	Args string // usage hint shown next to Name, empty if the command takes none
	Help string
}

// Commands is the whole palette -- "at minimum enough to switch mode and
// open the thread/model pickers" (Phase 3's own scope line). New commands
// append here; nothing else needs to change to make one appear in
// Suggest's completion list.
var Commands = []SlashCommand{
	{Name: "mode", Args: "plan|interactive|edit|auto", Help: "switch permission mode"},
	{Name: "threads", Help: "list, search, resume or delete threads"},
	{Name: "models", Help: "pick a provider and model"},
	{Name: "settings", Help: "manage AI provider keys"},
	{Name: "compact", Help: "compact this thread's history now"},
	{Name: "export", Help: "create a shareable export of this thread"},
	{Name: "help", Help: "show this list"},
}

// Suggest returns the commands whose name starts with input's first word,
// with input's leading "/" stripped -- only while that word has no
// trailing space yet, i.e. while the user is still typing the command name
// rather than its arguments. Returns nil for anything not starting with
// "/", which is how a caller decides whether to show the palette at all.
func Suggest(input string) []SlashCommand {
	if !strings.HasPrefix(input, "/") {
		return nil
	}
	rest := input[1:]
	if strings.ContainsAny(rest, " \t\n") {
		return nil
	}
	var out []SlashCommand
	for _, c := range Commands {
		if strings.HasPrefix(c.Name, rest) {
			out = append(out, c)
		}
	}
	return out
}

// Parse splits a composer line into a command name and its argument string.
// ok is false for anything not starting with "/".
func Parse(input string) (name, args string, ok bool) {
	if !strings.HasPrefix(input, "/") {
		return "", "", false
	}
	rest := strings.TrimSpace(input[1:])
	name, args, _ = strings.Cut(rest, " ")
	return name, strings.TrimSpace(args), true
}

// RenderSuggestions draws matches as a compact list under the composer,
// highlighting the selected row -- what Tab (accept) and the arrow keys
// move over.
func RenderSuggestions(width int, matches []SlashCommand, selected int) string {
	if len(matches) == 0 {
		return ""
	}
	var b strings.Builder
	for i, c := range matches {
		line := "/" + c.Name
		if c.Args != "" {
			line += " " + c.Args
		}
		line += "  " + c.Help
		style := theme.Default.Muted
		if i == selected {
			style = theme.Default.System.Bold(true)
		}
		if i > 0 {
			b.WriteString("\n")
		}
		b.WriteString(lipgloss.NewStyle().MaxWidth(width).Render(style.Render(line)))
	}
	return b.String()
}
