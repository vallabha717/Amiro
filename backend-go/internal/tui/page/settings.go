package page

import (
	"context"
	"fmt"
	"strings"

	"github.com/charmbracelet/bubbles/key"
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"

	"amiro/backend/internal/tui/client"
	"amiro/backend/internal/tui/keys"
	"amiro/backend/internal/tui/theme"
)

// knownProvider is one entry in the settings page's picker -- a curated
// slug/label pair, not a fetch, because there is no "list every provider
// Bifrost supports" endpoint; GET /api/ai/providers only returns
// connections that already exist. Matches the provider slugs
// bifrostai.Resolve already recognizes.
type knownProvider struct{ Slug, Label string }

var knownProviders = []knownProvider{
	{Slug: "anthropic", Label: "Anthropic"},
	{Slug: "openai", Label: "OpenAI"},
	{Slug: "google", Label: "Google"},
	{Slug: "openrouter", Label: "OpenRouter"},
	{Slug: "azure", Label: "Azure OpenAI"},
}

// settingsStep is which half of the page is focused.
type settingsStep int

const (
	settingsStepPick settingsStep = iota
	settingsStepKey
)

type providersLoadedMsg struct {
	rows []client.ProviderStatus
	err  error
}

type providerSavedMsg struct {
	provider string
	err      error
}

// Settings is the settings page (plan's page/settings.go): "provider keys,
// defaults". Phase 4's scope is provider keys -- the same DB-backed
// ProviderRepository the desktop app's own settings screen reads and
// writes (GET/POST /api/ai/providers), so a key saved here is a key the
// desktop app sees on its next fetch, and vice versa. Permission-mode and
// model defaults already have their own live-switching surfaces (Phase 3's
// /mode and the model picker); this page does not duplicate them.
type Settings struct {
	c client.Client

	rows    []client.ProviderStatus
	cursor  int
	loading bool
	err     error

	step  settingsStep
	input textinput.Model

	saving bool
	notice string
}

// NewSettings starts the page; Init issues the fetch.
func NewSettings(c client.Client) Settings {
	input := textinput.New()
	input.Placeholder = "paste API key"
	input.EchoMode = textinput.EchoPassword
	input.EchoCharacter = '•'
	return Settings{c: c, loading: true, input: input}
}

func (m Settings) Init() tea.Cmd {
	return m.load
}

func (m Settings) load() tea.Msg {
	rows, err := m.c.ListProviders(context.Background())
	return providersLoadedMsg{rows: rows, err: err}
}

func (m Settings) save(provider knownProvider, apiKey string) tea.Cmd {
	return func() tea.Msg {
		err := m.c.SetProviderKey(context.Background(), provider.Slug, provider.Label, apiKey)
		return providerSavedMsg{provider: provider.Label, err: err}
	}
}

func (m Settings) Update(msg tea.Msg) (Settings, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		return m, nil

	case providersLoadedMsg:
		m.loading = false
		m.err = msg.err
		m.rows = msg.rows
		return m, nil

	case providerSavedMsg:
		m.saving = false
		if msg.err != nil {
			m.err = msg.err
		} else {
			m.notice = "saved " + msg.provider
			m.step = settingsStepPick
			m.input.Reset()
		}
		return m, m.load

	case tea.KeyMsg:
		if m.saving {
			return m, nil
		}
		if m.step == settingsStepKey {
			return m.updateKeyEntry(msg)
		}
		return m.updatePicker(msg)
	}
	return m, nil
}

func (m Settings) updatePicker(msg tea.KeyMsg) (Settings, tea.Cmd) {
	switch {
	case key.Matches(msg, keys.DefaultPickerKeyMap.Cancel):
		return m, func() tea.Msg { return PickerCancelledMsg{} }

	case key.Matches(msg, keys.DefaultPickerKeyMap.Up):
		if m.cursor > 0 {
			m.cursor--
		}
		return m, nil

	case key.Matches(msg, keys.DefaultPickerKeyMap.Down):
		if m.cursor < len(knownProviders)-1 {
			m.cursor++
		}
		return m, nil

	case key.Matches(msg, keys.DefaultPickerKeyMap.Select):
		m.step = settingsStepKey
		m.notice = ""
		m.input.Focus()
		return m, textinput.Blink
	}
	return m, nil
}

func (m Settings) updateKeyEntry(msg tea.KeyMsg) (Settings, tea.Cmd) {
	switch msg.Type {
	case tea.KeyEsc:
		m.step = settingsStepPick
		m.input.Blur()
		m.input.Reset()
		return m, nil

	case tea.KeyEnter:
		apiKey := strings.TrimSpace(m.input.Value())
		if apiKey == "" {
			return m, nil
		}
		m.saving = true
		return m, m.save(knownProviders[m.cursor], apiKey)
	}

	var cmd tea.Cmd
	m.input, cmd = m.input.Update(msg)
	return m, cmd
}

func (m Settings) View() string {
	var b strings.Builder
	b.WriteString(theme.Default.System.Render("Settings  ·  AI provider keys  ·  esc to cancel"))
	b.WriteString("\n\n")

	switch {
	case m.loading:
		b.WriteString(theme.Default.Muted.Render("loading providers…"))
	case m.err != nil:
		b.WriteString(theme.Default.Error.Render("error: " + m.err.Error()))
	default:
		b.WriteString(theme.Default.Muted.Render("configured:"))
		b.WriteString("\n")
		if len(m.rows) == 0 {
			b.WriteString(theme.Default.Muted.Render("  (none yet)"))
		}
		for _, r := range m.rows {
			status := "not configured"
			if r.Configured {
				status = "configured"
			}
			b.WriteString(fmt.Sprintf("  %-16s %s\n", r.Name, status))
		}
	}

	b.WriteString("\n")
	if m.saving {
		b.WriteString(theme.Default.Muted.Render("saving…"))
	} else if m.step == settingsStepKey {
		b.WriteString(fmt.Sprintf("API key for %s:\n", knownProviders[m.cursor].Label))
		b.WriteString(m.input.View())
	} else {
		b.WriteString(theme.Default.Muted.Render("add or update a key  ·  enter to select  ·  ↑/↓ to move"))
		b.WriteString("\n\n")
		for i, p := range knownProviders {
			line := p.Label
			if i == m.cursor {
				b.WriteString(theme.Default.System.Bold(true).Render("> " + line))
			} else {
				b.WriteString("  " + line)
			}
			b.WriteString("\n")
		}
	}

	if m.notice != "" {
		b.WriteString("\n")
		b.WriteString(theme.Default.System.Render(m.notice))
	}
	return b.String()
}
