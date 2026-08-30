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

// githubRow is the picker's one row beyond knownProviders -- see
// docs/coding-agent-parity/04-git-remote-operations.md. It is a distinct
// row rather than one more knownProvider because it does not go through
// SetProviderKey/ListProviders at all: a GitHub token is its own
// internal/secrets entry, connected/disconnected through /api/github/*,
// not the DB-backed provider config every row above it edits.
var githubRow = len(knownProviders)

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

type githubStatusLoadedMsg struct {
	connected bool
	err       error
}

type githubConnectedMsg struct{ err error }
type githubDisconnectedMsg struct{ err error }

// Settings is the settings page (plan's page/settings.go): "provider keys,
// defaults". Phase 4's scope is provider keys -- the same DB-backed
// ProviderRepository the desktop app's own settings screen reads and
// writes (GET/POST /api/ai/providers), so a key saved here is a key the
// desktop app sees on its next fetch, and vice versa. Permission-mode and
// model defaults already have their own live-switching surfaces (Phase 3's
// /mode and the model picker); this page does not duplicate them.
//
// Phase 3 of docs/coding-agent-parity/ added the one row below the
// provider list: GitHub connect/disconnect, gating git push and create_pr.
type Settings struct {
	c client.Client

	rows    []client.ProviderStatus
	cursor  int
	loading bool
	err     error

	githubConnected bool
	githubLoading   bool

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
	return Settings{c: c, loading: true, githubLoading: true, input: input}
}

func (m Settings) Init() tea.Cmd {
	return tea.Batch(m.load, m.loadGitHub)
}

func (m Settings) load() tea.Msg {
	rows, err := m.c.ListProviders(context.Background())
	return providersLoadedMsg{rows: rows, err: err}
}

func (m Settings) loadGitHub() tea.Msg {
	connected, err := m.c.GitHubStatus(context.Background())
	return githubStatusLoadedMsg{connected: connected, err: err}
}

func (m Settings) save(provider knownProvider, apiKey string) tea.Cmd {
	return func() tea.Msg {
		err := m.c.SetProviderKey(context.Background(), provider.Slug, provider.Label, apiKey)
		return providerSavedMsg{provider: provider.Label, err: err}
	}
}

func (m Settings) connectGitHub(token string) tea.Cmd {
	return func() tea.Msg {
		err := m.c.ConnectGitHub(context.Background(), token)
		return githubConnectedMsg{err: err}
	}
}

func (m Settings) disconnectGitHub() tea.Cmd {
	return func() tea.Msg {
		err := m.c.DisconnectGitHub(context.Background())
		return githubDisconnectedMsg{err: err}
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

	case githubStatusLoadedMsg:
		m.githubLoading = false
		if msg.err != nil {
			m.err = msg.err
		} else {
			m.githubConnected = msg.connected
		}
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

	case githubConnectedMsg:
		m.saving = false
		if msg.err != nil {
			m.err = msg.err
		} else {
			m.notice = "connected GitHub"
			m.step = settingsStepPick
			m.input.Reset()
		}
		return m, m.loadGitHub

	case githubDisconnectedMsg:
		m.saving = false
		if msg.err != nil {
			m.err = msg.err
		} else {
			m.notice = "disconnected GitHub"
		}
		return m, m.loadGitHub

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
		if m.cursor < githubRow {
			m.cursor++
		}
		return m, nil

	case msg.String() == "d" && m.cursor == githubRow && m.githubConnected:
		// Disconnect is a direct action, not routed through the key-entry
		// step -- there is no token to type to remove one.
		m.saving = true
		m.notice = ""
		return m, m.disconnectGitHub()

	case key.Matches(msg, keys.DefaultPickerKeyMap.Select):
		if m.cursor == githubRow {
			if m.githubConnected {
				// Already connected: enter re-enters key entry to replace
				// the token, since Connect overwrites rather than requiring
				// a disconnect first.
				m.step = settingsStepKey
				m.notice = ""
				m.input.Placeholder = "paste a new GitHub token to replace it"
				m.input.Focus()
				return m, textinput.Blink
			}
			m.step = settingsStepKey
			m.notice = ""
			m.input.Placeholder = "paste a GitHub personal access token"
			m.input.Focus()
			return m, textinput.Blink
		}
		m.step = settingsStepKey
		m.notice = ""
		m.input.Placeholder = "paste API key"
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
		value := strings.TrimSpace(m.input.Value())
		if value == "" {
			return m, nil
		}
		m.saving = true
		if m.cursor == githubRow {
			return m, m.connectGitHub(value)
		}
		return m, m.save(knownProviders[m.cursor], value)
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
		label := "API key for " + knownProviders[m.cursor].Label
		if m.cursor == githubRow {
			label = "GitHub personal access token"
		}
		b.WriteString(label + ":\n")
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
		b.WriteString(m.githubRowView())
	}

	if m.notice != "" {
		b.WriteString("\n")
		b.WriteString(theme.Default.System.Render(m.notice))
	}
	return b.String()
}

// githubRowView renders the picker's GitHub row, distinct from the
// provider rows above it: it names its connection state directly ("Github
// (connected)"/"(not connected)") since there is no separate "configured:"
// section it belongs to the way DB-backed providers do.
func (m Settings) githubRowView() string {
	status := "not connected"
	if m.githubLoading {
		status = "…"
	} else if m.githubConnected {
		status = "connected"
	}
	line := fmt.Sprintf("GitHub (%s)", status)
	if m.cursor == githubRow {
		out := theme.Default.System.Bold(true).Render("> "+line) + "\n"
		if m.githubConnected {
			out += theme.Default.Muted.Render("  enter to replace the token  ·  d to disconnect") + "\n"
		}
		return out
	}
	return "  " + line + "\n"
}
