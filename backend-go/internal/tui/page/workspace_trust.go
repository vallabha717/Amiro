package page

import (
	"context"
	"encoding/json"

	tea "github.com/charmbracelet/bubbletea"
)

// workspaceTrustMsg carries loadWorkspaceTrust's result back into Update.
type workspaceTrustMsg struct {
	trusted      bool
	resolvedRoot string
	err          error
}

// loadWorkspaceTrust checks once, at startup, whether the signed-in user
// has already granted m.workspaceRoot -- the TUI's version of the trust
// prompt appearing before the first message rather than as a stream of
// refused tool calls. Fired from resize's first call (see its doc comment
// for why not Init), not Init itself.
//
// A failed check (an older attached server with no trust routes, or the
// resolve itself failing) degrades to "don't show the prompt" rather than
// blocking the session on a check that couldn't run -- the same "optional
// dependency degrades" contract the backend side of this feature already
// has (chat.Handler.trust being nil).
func (m Chat) loadWorkspaceTrust() tea.Msg {
	if m.workspaceRoot == "" {
		return workspaceTrustMsg{trusted: true}
	}
	trusted, resolvedRoot, err := m.c.WorkspaceTrustStatus(context.Background(), m.workspaceRoot)
	return workspaceTrustMsg{trusted: trusted, resolvedRoot: resolvedRoot, err: err}
}

// workspaceTrustGrantedMsg carries grantWorkspaceTrust's result back into
// Update.
type workspaceTrustGrantedMsg struct{ err error }

// grantWorkspaceTrust is the human's "yes" answer to the trust prompt,
// sent as its own async command (not answered inline) so a slow request
// doesn't freeze Update -- the same reason every other network call in
// this page is a tea.Cmd rather than a direct call.
func (m Chat) grantWorkspaceTrust() tea.Msg {
	err := m.c.GrantWorkspaceTrust(context.Background(), m.workspaceRoot)
	return workspaceTrustGrantedMsg{err: err}
}

// workspaceTrustPromptInput renders as the dialog's "what you're being
// asked to grant" preview -- the resolved root, the same information the
// web prompt shows.
func workspaceTrustPromptInput(resolvedRoot string) json.RawMessage {
	b, _ := json.Marshal(map[string]string{"root": resolvedRoot})
	return b
}
