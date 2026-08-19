package page

import (
	"context"
	"fmt"
	"strings"

	"github.com/charmbracelet/bubbles/key"
	tea "github.com/charmbracelet/bubbletea"

	"amiro/backend/internal/tui/client"
	"amiro/backend/internal/tui/keys"
	"amiro/backend/internal/tui/theme"
)

// modelOption is one selectable row -- a provider's model, flattened out of
// client.ProviderModels' grouped shape because the picker itself is a flat
// list.
type modelOption struct {
	Provider     string
	ProviderName string
	Model        string
}

// modelsLoadedMsg carries ListModels' result back into Update -- a page
// cannot block Init/Update on a network call (plan §2.7: Update must never
// block), so the fetch runs as a tea.Cmd and reports back as a message.
type modelsLoadedMsg struct {
	options []modelOption
	err     error
}

// Models is the model picker (plan's page/models.go): provider/model
// selection over whatever GET /api/chat/models already exposes -- already
// filtered server-side to providers with a configured key.
type Models struct {
	c client.Client

	options  []modelOption
	filtered []modelOption
	filter   string
	cursor   int
	loading  bool
	err      error

	width, height int
}

// NewModels starts the picker; Init issues the fetch.
func NewModels(c client.Client) Models {
	return Models{c: c, loading: true}
}

func (m Models) Init() tea.Cmd {
	return m.load
}

func (m Models) load() tea.Msg {
	rows, err := m.c.ListModels(context.Background())
	if err != nil {
		return modelsLoadedMsg{err: err}
	}
	var options []modelOption
	for _, p := range rows {
		for _, model := range p.Models {
			options = append(options, modelOption{Provider: p.Provider, ProviderName: p.ProviderName, Model: model})
		}
	}
	return modelsLoadedMsg{options: options}
}

func (m Models) Update(msg tea.Msg) (Models, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
		return m, nil

	case modelsLoadedMsg:
		m.loading = false
		m.err = msg.err
		m.options = msg.options
		m.applyFilter()
		return m, nil

	case tea.KeyMsg:
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
				chosen := m.filtered[m.cursor]
				return m, func() tea.Msg { return ModelChosenMsg{Provider: chosen.Provider, Model: chosen.Model} }
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

func (m *Models) applyFilter() {
	m.filtered = m.filtered[:0]
	needle := strings.ToLower(m.filter)
	for _, o := range m.options {
		haystack := strings.ToLower(o.ProviderName + " " + o.Provider + " " + o.Model)
		if needle == "" || strings.Contains(haystack, needle) {
			m.filtered = append(m.filtered, o)
		}
	}
	if m.cursor >= len(m.filtered) {
		m.cursor = max(len(m.filtered)-1, 0)
	}
}

func (m Models) View() string {
	var b strings.Builder
	b.WriteString(theme.Default.System.Render("Select a model  ·  type to filter  ·  esc to cancel"))
	b.WriteString("\n\n")

	switch {
	case m.loading:
		b.WriteString(theme.Default.Muted.Render("loading models…"))
	case m.err != nil:
		b.WriteString(theme.Default.Error.Render("could not load models: " + m.err.Error()))
	case len(m.options) == 0:
		b.WriteString(theme.Default.Muted.Render("no provider has a configured API key yet"))
	case len(m.filtered) == 0:
		b.WriteString(theme.Default.Muted.Render("no matches for " + m.filter))
	default:
		for i, o := range m.filtered {
			line := fmt.Sprintf("%s / %s", o.ProviderName, o.Model)
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
