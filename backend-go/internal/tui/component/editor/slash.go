// Package editor holds composer behavior that sits on top of
// bubbles/textarea -- Phase 3's slash-command palette (plan §3's Part 4:
// "the composer needs a /-triggered command palette"). It has no tea.Model
// of its own; page.Chat still owns the textarea and its Update loop, and
// calls into this package for the parts that are the same regardless of
// which page embeds a composer.
package editor

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/lipgloss"

	"amiro/backend/internal/tui/theme"
)

// SlashCommand is one entry in the palette for built-in commands.
type SlashCommand struct {
	Name string // typed after "/", e.g. "mode"
	Args string // usage hint shown next to Name, empty if the command takes none
	Help string
}

// SkillCommand is one dynamic skill in the palette.
type SkillCommand struct {
	Name        string // Canonical skill name, e.g. "export" or "summarize"
	Invoke      string // Invocation name, e.g. "skill:export" (if shadowed) or "summarize"
	Description string // Description
	Source      string // Source directory, e.g. ".agents", ".claude"
	Scope       string // "project" or "user"
}

// SlashMatch is one suggestion item resulting from Suggest.
type SlashMatch struct {
	Name    string
	Invoke  string
	Args    string
	Help    string
	IsSkill bool
	Source  string
	Scope   string
}

// Commands is the whole palette of static built-ins -- "at minimum enough to switch mode and
// open the thread/model pickers" (Phase 3's own scope line).
var Commands = []SlashCommand{
	{Name: "mode", Args: "plan|interactive|edit|auto", Help: "switch permission mode"},
	{Name: "threads", Help: "list, search, resume or delete threads"},
	{Name: "runs", Help: "list background agent runs, resume one by opening its thread"},
	{Name: "models", Help: "pick a provider and model"},
	{Name: "settings", Help: "manage AI provider keys"},
	{Name: "compact", Help: "compact this thread's history now"},
	{Name: "rewind", Help: "revert the most recent turn's file changes"},
	{Name: "export", Help: "create a shareable export of this thread"},
	{Name: "skills", Help: "list discovered skills with source and scope"},
	{Name: "help", Help: "show this list"},
}

// maxRenderedMatches is the maximum number of suggestion rows to display
// before truncating with a "+N more" line.
const maxRenderedMatches = 10

// Suggest returns the commands whose name starts with input's first word,
// with input's leading "/" stripped -- only while that word has no
// trailing space yet, i.e. while the user is still typing the command name
// rather than its arguments. Built-in command names match first on Name,
// then skills match second on Invoke. Returns nil for anything not starting
// with "/", which is how a caller decides whether to show the palette at all.
func Suggest(input string, skills []SkillCommand) []SlashMatch {
	if !strings.HasPrefix(input, "/") {
		return nil
	}
	rest := input[1:]
	if strings.ContainsAny(rest, " \t\n") {
		return nil
	}
	out := make([]SlashMatch, 0)
	for _, c := range Commands {
		if strings.HasPrefix(c.Name, rest) {
			out = append(out, SlashMatch{
				Name:    c.Name,
				Invoke:  c.Name,
				Args:    c.Args,
				Help:    c.Help,
				IsSkill: false,
			})
		}
	}
	for _, s := range skills {
		if strings.HasPrefix(s.Invoke, rest) {
			out = append(out, SlashMatch{
				Name:    s.Name,
				Invoke:  s.Invoke,
				Help:    s.Description,
				IsSkill: true,
				Source:  s.Source,
				Scope:   s.Scope,
			})
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
// highlighting the selected row. When skills are present, it groups built-ins
// first, followed by a "skills" heading and skill items, capped at maxRenderedMatches
// with a "+N more" line.
func RenderSuggestions(width int, matches []SlashMatch, selected int) string {
	if len(matches) == 0 {
		return ""
	}

	var builtins []int
	var skillIdxs []int
	for i, m := range matches {
		if m.IsSkill {
			skillIdxs = append(skillIdxs, i)
		} else {
			builtins = append(builtins, i)
		}
	}

	// Zero skills discovered/matched: preserve byte-identical rendering of built-in suggestions
	if len(skillIdxs) == 0 {
		var b strings.Builder
		total := len(builtins)
		rendered := 0
		for _, idx := range builtins {
			if rendered >= maxRenderedMatches {
				break
			}
			c := matches[idx]
			line := "/" + c.Name
			if c.Args != "" {
				line += " " + c.Args
			}
			line += "  " + c.Help
			style := theme.Default.Muted
			if idx == selected {
				style = theme.Default.System.Bold(true)
			}
			if rendered > 0 {
				b.WriteString("\n")
			}
			b.WriteString(lipgloss.NewStyle().MaxWidth(width).Render(style.Render(line)))
			rendered++
		}
		if total > rendered {
			b.WriteString("\n")
			b.WriteString(lipgloss.NewStyle().MaxWidth(width).Render(theme.Default.Muted.Render(fmt.Sprintf("+%d more", total-rendered))))
		}
		return b.String()
	}

	// Mixed or skill-only suggestions
	var b strings.Builder
	rendered := 0
	lineCount := 0

	// 1. Built-in matches
	for _, idx := range builtins {
		if rendered >= maxRenderedMatches {
			break
		}
		c := matches[idx]
		line := "/" + c.Name
		if c.Args != "" {
			line += " " + c.Args
		}
		line += "  " + c.Help
		style := theme.Default.Muted
		if idx == selected {
			style = theme.Default.System.Bold(true)
		}
		if lineCount > 0 {
			b.WriteString("\n")
		}
		b.WriteString(lipgloss.NewStyle().MaxWidth(width).Render(style.Render(line)))
		rendered++
		lineCount++
	}

	// 2. Skills heading (rendered if there are skill matches and room left)
	if len(skillIdxs) > 0 && rendered < maxRenderedMatches {
		if lineCount > 0 {
			b.WriteString("\n")
		}
		b.WriteString(lipgloss.NewStyle().MaxWidth(width).Render(theme.Default.Muted.Render("skills")))
		lineCount++
	}

	// 3. Skill matches
	for _, idx := range skillIdxs {
		if rendered >= maxRenderedMatches {
			break
		}
		s := matches[idx]
		line := "/" + s.Invoke + "  " + s.Help
		style := theme.Default.Muted
		if idx == selected {
			style = theme.Default.System.Bold(true)
		}
		if lineCount > 0 {
			b.WriteString("\n")
		}
		b.WriteString(lipgloss.NewStyle().MaxWidth(width).Render(style.Render(line)))
		rendered++
		lineCount++
	}

	if len(matches) > rendered {
		b.WriteString("\n")
		b.WriteString(lipgloss.NewStyle().MaxWidth(width).Render(theme.Default.Muted.Render(fmt.Sprintf("+%d more", len(matches)-rendered))))
	}

	return b.String()
}

