// Package app is the TUI's root tea.Model. Phase 3 grows it from a single
// page into a small router (plan's "app/update.go: message dispatch"):
// Chat stays mounted underneath at all times (a picker overlays it, it
// never gets torn down), and page.Open*Msg/page.*ChosenMsg/
// page.PickerCancelledMsg -- defined in package page so no page imports a
// sibling page for a message type alone -- are what moves between them.
package app

import (
	tea "github.com/charmbracelet/bubbletea"

	"amiro/backend/internal/tui/client"
	"amiro/backend/internal/tui/page"
)

// active names which page currently owns the keyboard and the view below
// the header.
type active int

const (
	activeChat active = iota
	activeThreads
	activeModels
	activeSettings
	activeRuns
)

// Model is the whole program. cmd/amiro constructs one and hands it to
// tea.NewProgram.
type Model struct {
	c client.Client

	chat     page.Chat
	threads  page.Threads
	models   page.Models
	settings page.Settings
	runs     page.Runs
	active   active

	width, height int
}

// New builds the root model over an empty thread threadID, scoped to
// workspaceRoot -- both resolved by cmd/amiro before the program starts.
// mode is Appendix A's --mode flag; empty leaves the server's own
// interactive default in place.
func New(c client.Client, threadID, workspaceRoot, mode string) Model {
	chat := page.NewChat(c, threadID, workspaceRoot)
	if mode != "" {
		chat.SetMode(mode)
	}
	return Model{c: c, chat: chat}
}

// Resume builds the root model over an already-fetched thread -- cmd/amiro's
// --thread flag. detail is fetched before the program starts (a network
// round trip has no place inside Bubble Tea's Init/Update, which must never
// block -- plan §2.7), same reasoning page.Threads' resume path uses once
// the program is already running.
func Resume(c client.Client, detail client.ThreadDetail, workspaceRoot, mode string) Model {
	chat := page.NewChat(c, detail.ID, workspaceRoot)
	chat.LoadThread(detail)
	if mode != "" {
		chat.SetMode(mode)
	}
	return Model{c: c, chat: chat}
}

// SetModel pins every future turn to provider/model -- cmd/amiro's
// --model flag and config.yaml's defaultModel (internal/tui/config),
// applied once at startup before the program's first frame, the same way
// New/Resume apply mode.
func (m *Model) SetModel(provider, model string) {
	m.chat.SetModel(provider, model)
}

// SetDashboardURL is `amiro --serve`'s counterpart to SetModel: the
// address the embedded backend is serving the web dashboard on, shown in
// the status bar so it survives longer than a line on stderr.
func (m *Model) SetDashboardURL(url string) {
	m.chat.SetDashboardURL(url)
}

func (m Model) Init() tea.Cmd {
	return m.chat.Init()
}

func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
		// Every page gets sized, not just the active one: switching to a
		// picker that has never seen a WindowSizeMsg would render at its
		// zero value.
		var chatCmd, threadsCmd, modelsCmd, settingsCmd, runsCmd tea.Cmd
		m.chat, chatCmd = m.chat.Update(msg)
		m.threads, threadsCmd = m.threads.Update(msg)
		m.models, modelsCmd = m.models.Update(msg)
		m.settings, settingsCmd = m.settings.Update(msg)
		m.runs, runsCmd = m.runs.Update(msg)
		return m, tea.Batch(chatCmd, threadsCmd, modelsCmd, settingsCmd, runsCmd)

	case page.OpenThreadsMsg:
		m.threads = page.NewThreads(m.c)
		m.active = activeThreads
		return m, tea.Batch(m.threads.Init(), sizeCmd(m.width, m.height))

	case page.OpenRunsMsg:
		m.runs = page.NewRuns(m.c)
		m.active = activeRuns
		return m, tea.Batch(m.runs.Init(), sizeCmd(m.width, m.height))

	case page.OpenModelsMsg:
		m.models = page.NewModels(m.c)
		m.active = activeModels
		return m, tea.Batch(m.models.Init(), sizeCmd(m.width, m.height))

	case page.OpenSettingsMsg:
		m.settings = page.NewSettings(m.c)
		m.active = activeSettings
		return m, tea.Batch(m.settings.Init(), sizeCmd(m.width, m.height))

	case page.PickerCancelledMsg:
		m.active = activeChat
		return m, nil

	case page.ThreadChosenMsg:
		m.chat.LoadThread(msg.Detail)
		m.active = activeChat
		return m, nil

	case page.ModelChosenMsg:
		m.chat.SetModel(msg.Provider, msg.Model)
		m.active = activeChat
		return m, nil
	}

	var cmd tea.Cmd
	switch m.active {
	case activeThreads:
		m.threads, cmd = m.threads.Update(msg)
	case activeModels:
		m.models, cmd = m.models.Update(msg)
	case activeSettings:
		m.settings, cmd = m.settings.Update(msg)
	case activeRuns:
		m.runs, cmd = m.runs.Update(msg)
	default:
		m.chat, cmd = m.chat.Update(msg)
	}
	return m, cmd
}

func (m Model) View() string {
	switch m.active {
	case activeThreads:
		return m.threads.View()
	case activeModels:
		return m.models.View()
	case activeSettings:
		return m.settings.View()
	case activeRuns:
		return m.runs.View()
	default:
		return m.chat.View()
	}
}

// sizeCmd re-delivers the current terminal size as a tea.Msg -- a page that
// mounts after the initial tea.WindowSizeMsg (any picker, which is created
// lazily on first open) has never seen one otherwise.
func sizeCmd(width, height int) tea.Cmd {
	return func() tea.Msg { return tea.WindowSizeMsg{Width: width, Height: height} }
}
