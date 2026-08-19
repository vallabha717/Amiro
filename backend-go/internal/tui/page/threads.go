package page

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/key"
	tea "github.com/charmbracelet/bubbletea"

	"amiro/backend/internal/tui/client"
	"amiro/backend/internal/tui/keys"
	"amiro/backend/internal/tui/theme"
)

// threadsLoadedMsg carries ListThreads' result back into Update, same
// non-blocking-Update reasoning as models.go's modelsLoadedMsg.
type threadsLoadedMsg struct {
	rows []client.ThreadSummary
	err  error
}

// threadLoadedMsg carries one GetThread call's result -- resuming needs the
// full history, fetched only once a row is actually picked.
type threadLoadedMsg struct {
	detail client.ThreadDetail
	err    error
}

// threadDeletedMsg confirms a DeleteThread call so Update can refresh the
// list rather than trusting the row is gone client-side.
type threadDeletedMsg struct {
	id  string
	err error
}

// Threads is the thread switcher (plan's page/threads.go): list, search,
// resume, delete.
type Threads struct {
	c client.Client

	rows     []client.ThreadSummary
	filtered []client.ThreadSummary
	filter   string
	cursor   int
	loading  bool
	err      error

	// resuming is set while a GetThread fetch for the selected row is in
	// flight -- Select is disabled meanwhile so a double Enter can't queue
	// two fetches.
	resuming bool
}

// NewThreads starts the switcher; Init issues the list fetch.
func NewThreads(c client.Client) Threads {
	return Threads{c: c, loading: true}
}

func (m Threads) Init() tea.Cmd {
	return m.load
}

func (m Threads) load() tea.Msg {
	rows, err := m.c.ListThreads(context.Background())
	return threadsLoadedMsg{rows: rows, err: err}
}

func (m Threads) resume(id string) tea.Cmd {
	return func() tea.Msg {
		detail, err := m.c.GetThread(context.Background(), id)
		return threadLoadedMsg{detail: detail, err: err}
	}
}

func (m Threads) delete(id string) tea.Cmd {
	return func() tea.Msg {
		err := m.c.DeleteThread(context.Background(), id)
		return threadDeletedMsg{id: id, err: err}
	}
}

func (m Threads) Update(msg tea.Msg) (Threads, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		return m, nil

	case threadsLoadedMsg:
		m.loading = false
		m.err = msg.err
		m.rows = msg.rows
		m.applyFilter()
		return m, nil

	case threadLoadedMsg:
		m.resuming = false
		if msg.err != nil {
			m.err = msg.err
			return m, nil
		}
		return m, func() tea.Msg { return ThreadChosenMsg{Detail: msg.detail} }

	case threadDeletedMsg:
		if msg.err != nil {
			m.err = msg.err
			return m, nil
		}
		return m, m.load

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
				return m, m.resume(m.filtered[m.cursor].ID)
			}
			return m, nil

		case key.Matches(msg, keys.DefaultPickerKeyMap.Delete):
			if m.cursor >= 0 && m.cursor < len(m.filtered) {
				return m, m.delete(m.filtered[m.cursor].ID)
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

func (m *Threads) applyFilter() {
	m.filtered = m.filtered[:0]
	needle := strings.ToLower(m.filter)
	for _, r := range m.rows {
		if needle == "" || strings.Contains(strings.ToLower(r.Title), needle) {
			m.filtered = append(m.filtered, r)
		}
	}
	if m.cursor >= len(m.filtered) {
		m.cursor = max(len(m.filtered)-1, 0)
	}
}

func (m Threads) View() string {
	var b strings.Builder
	b.WriteString(theme.Default.System.Render(
		"Threads  ·  type to search  ·  enter to resume  ·  ctrl+d to delete  ·  esc to cancel",
	))
	b.WriteString("\n\n")

	switch {
	case m.loading:
		b.WriteString(theme.Default.Muted.Render("loading threads…"))
	case m.err != nil:
		b.WriteString(theme.Default.Error.Render("error: " + m.err.Error()))
	case m.resuming:
		b.WriteString(theme.Default.Muted.Render("resuming…"))
	case len(m.rows) == 0:
		b.WriteString(theme.Default.Muted.Render("no threads yet"))
	case len(m.filtered) == 0:
		b.WriteString(theme.Default.Muted.Render("no matches for " + m.filter))
	default:
		for i, r := range m.filtered {
			title := r.Title
			if title == "" {
				title = "(untitled)"
			}
			line := fmt.Sprintf("%-40s  %s", truncate(title, 40), lastActive(r))
			if i == m.cursor {
				b.WriteString(theme.Default.System.Bold(true).Render("> " + line))
			} else {
				b.WriteString("  " + line)
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

func lastActive(r client.ThreadSummary) string {
	if r.LastMessageAt == 0 {
		return r.CreatedAt.Format("2006-01-02 15:04")
	}
	return time.UnixMilli(r.LastMessageAt).Format("2006-01-02 15:04")
}

func truncate(s string, max int) string {
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max-1]) + "…"
}
