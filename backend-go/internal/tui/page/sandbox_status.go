package page

import (
	"context"

	tea "github.com/charmbracelet/bubbletea"
)

// sandboxStatusMsg carries loadSandboxStatus's result back into Update.
type sandboxStatusMsg struct {
	backend string
	err     error
}

// loadSandboxStatus checks once, at startup, which run_shell sandbox
// backend the attached server detected
// (docs/coding-agent-parity/03-sandboxed-execution.md) -- fired from Init
// so the status bar's indicator is populated before the first command
// ever runs.
//
// A failed check (an older attached server with no /api/sandbox/status
// route, or the request itself failing) degrades to "leave the field
// unset" rather than showing a wrong or misleading value -- the same
// "optional dependency degrades" contract loadWorkspaceTrust already has.
func (m Chat) loadSandboxStatus() tea.Msg {
	backend, _, err := m.c.SandboxStatus(context.Background())
	return sandboxStatusMsg{backend: backend, err: err}
}
