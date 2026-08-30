package page

import (
	"context"
	"fmt"
	"strings"

	"github.com/charmbracelet/bubbles/key"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"amiro/backend/internal/tui/client"
	"amiro/backend/internal/tui/keys"
	"amiro/backend/internal/tui/theme"
)

// runsLoadedMsg carries ListBackgroundJobs' result back into Update, same
// non-blocking-Update reasoning as threads.go's threadsLoadedMsg.
type runsLoadedMsg struct {
	rows []client.BackgroundJob
	err  error
}

// runResumeMsg carries the fetched thread for a chosen run -- resuming a
// run means opening its thread, exactly like Threads.resume, since a
// suspended run's pending approval already lives there as an ordinary part
// (docs/coding-agent-parity/05-background-agent-runs.md's "resolvable from
// any surface" decision: there is no second resolution path to route
// through here).
type runResumeMsg struct {
	detail client.ThreadDetail
	err    error
}

// Runs is the background-job picker ("/runs"): list, search, resume by
// opening the job's thread. Mirrors Threads' shape closely -- the same
// list/filter/select picker pattern, over a different backend list.
type Runs struct {
	c client.Client

	rows     []client.BackgroundJob
	filtered []client.BackgroundJob
	filter   string
	cursor   int
	loading  bool
	err      error

	// resuming guards against a double Enter queuing two thread fetches,
	// same reasoning as Threads.resuming.
	resuming bool
}

// NewRuns starts the picker; Init issues the list fetch.
func NewRuns(c client.Client) Runs {
	return Runs{c: c, loading: true}
}

func (m Runs) Init() tea.Cmd {
	return m.load
}

func (m Runs) load() tea.Msg {
	rows, err := m.c.ListBackgroundJobs(context.Background())
	return runsLoadedMsg{rows: rows, err: err}
}

func (m Runs) resume(job client.BackgroundJob) tea.Cmd {
	return func() tea.Msg {
		detail, err := m.c.GetThread(context.Background(), job.ThreadID)
		return runResumeMsg{detail: detail, err: err}
	}
}

func (m Runs) Update(msg tea.Msg) (Runs, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		return m, nil

	case runsLoadedMsg:
		m.loading = false
		m.err = msg.err
		m.rows = msg.rows
		m.applyFilter()
		return m, nil

	case runResumeMsg:
		m.resuming = false
		if msg.err != nil {
			m.err = msg.err
			return m, nil
		}
		return m, func() tea.Msg { return ThreadChosenMsg{Detail: msg.detail} }

	case tea.KeyMsg:
		if m.resuming {
			return m, nil
		}
		switch {
		case key.Matches(msg, keys.DefaultPickerKeyMap.Cancel):
			return m, func() tea.Msg { return PickerCancelledMsg{} }

		case key.Matches(msg, keys.DefaultPickerKeyMap.Up):
			if m.cursor > 0 {
				m.cursor--
			}
			return m, nil

		case key.Matches(msg, keys.DefaultPickerKeyMap.Down):
			if m.cursor < len(m.filtered)-1 {
				m.cursor++
			}
			return m, nil

		case key.Matches(msg, keys.DefaultPickerKeyMap.Select):
			if m.cursor >= 0 && m.cursor < len(m.filtered) {
				m.resuming = true
				return m, m.resume(m.filtered[m.cursor])
			}
			return m, nil

		case msg.Type == tea.KeyBackspace:
			if m.filter != "" {
				m.filter = m.filter[:len(m.filter)-1]
				m.applyFilter()
			}
			return m, nil

		case msg.Type == tea.KeyRunes:
			m.filter += string(msg.Runes)
			m.applyFilter()
			return m, nil
		}
	}
	return m, nil
}

func (m *Runs) applyFilter() {
	m.filtered = m.filtered[:0]
	needle := strings.ToLower(m.filter)
	for _, r := range m.rows {
		if needle == "" || strings.Contains(strings.ToLower(r.Prompt), needle) || strings.Contains(strings.ToLower(r.Status), needle) {
			m.filtered = append(m.filtered, r)
		}
	}
	if m.cursor >= len(m.filtered) {
		m.cursor = max(len(m.filtered)-1, 0)
	}
}

func (m Runs) View() string {
	var b strings.Builder
	b.WriteString(theme.Default.System.Render(
		"Background runs  ·  type to search  ·  enter to open the run's thread  ·  esc to cancel",
	))
	b.WriteString("\n\n")

	switch {
	case m.loading:
		b.WriteString(theme.Default.Muted.Render("loading runs…"))
	case m.err != nil:
		b.WriteString(theme.Default.Error.Render("error: " + m.err.Error()))
	case m.resuming:
		b.WriteString(theme.Default.Muted.Render("opening…"))
	case len(m.rows) == 0:
		b.WriteString(theme.Default.Muted.Render("no background runs yet"))
	case len(m.filtered) == 0:
		b.WriteString(theme.Default.Muted.Render("no matches for " + m.filter))
	default:
		for i, r := range m.filtered {
			line := fmt.Sprintf("[%-11s] %s", r.Status, truncate(r.Prompt, 50))
			if r.AutoPR {
				line += "  (auto-pr)"
			}
			if i == m.cursor {
				b.WriteString(theme.Default.System.Bold(true).Render("> " + line))
			} else {
				b.WriteString("  " + statusStyle(r.Status).Render(line))
			}
			b.WriteString("\n")
		}
	}

	if m.filter != "" {
		b.WriteString("\n")
		b.WriteString(theme.Default.Muted.Render("filter: " + m.filter))
	}
	return b.String()
}

// statusStyle highlights a run needing attention -- suspended (waiting on
// an approval) and failed both deserve to stand out in a list a user is
// scanning for "what needs me."
func statusStyle(status string) lipgloss.Style {
	switch status {
	case "suspended", "failed", "interrupted":
		return theme.Default.Error
	default:
		return theme.Default.Muted
	}
}
