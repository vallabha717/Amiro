// Package keys is the TUI's one keymap, so a binding is declared once and
// every page and the help view read the same source (plan §3, Appendix B).
// Phase 1 only wires the bindings the chat page actually uses; the rest of
// Appendix B's table lands with the pages that need them.
package keys

import "github.com/charmbracelet/bubbles/key"

// ChatKeyMap is the chat page's bindings.
type ChatKeyMap struct {
	Send      key.Binding
	Newline   key.Binding
	Interrupt key.Binding
	ScrollUp  key.Binding
	ScrollDn  key.Binding

	// Threads, Models and Palette are Phase 3's additions (Appendix B):
	// direct shortcuts to the thread switcher and model picker, and a
	// command palette listing both plus every /slash command -- the same
	// destinations typing "/threads" or "/models" into the composer reaches,
	// for a user who'd rather not type.
	Threads key.Binding
	Models  key.Binding
	Palette key.Binding

	// Rewind is Esc, pressed twice within a short window, as a shortcut for
	// "/rewind the most recent turn"
	// (docs/coding-agent-parity/02-checkpoints-and-rewind.md). The double-
	// press timing itself is page.Chat's job (a single key.Binding cannot
	// express "twice") -- this binding exists so there is one canonical
	// place Esc's rewind meaning is declared, matching every other key in
	// this file, rather than a literal tea.KeyEsc check living only in
	// chat.go.
	Rewind key.Binding
}

// DefaultChatKeyMap is Appendix B's keymap: Enter to send, Shift+Enter
// or Ctrl+J for a literal newline, Ctrl+C to interrupt a turn and, on an
// idle prompt, quit -- textarea.Model already owns the newline binding by
// default, so Newline here documents it rather than rebinding it.
var DefaultChatKeyMap = ChatKeyMap{
	Send: key.NewBinding(
		key.WithKeys("enter"),
		key.WithHelp("enter", "send"),
	),
	Newline: key.NewBinding(
		key.WithKeys("shift+enter", "ctrl+j"),
		key.WithHelp("shift+enter", "newline"),
	),
	Interrupt: key.NewBinding(
		key.WithKeys("ctrl+c"),
		key.WithHelp("ctrl+c", "interrupt / quit"),
	),
	ScrollUp: key.NewBinding(
		key.WithKeys("pgup"),
		key.WithHelp("pgup", "scroll up"),
	),
	ScrollDn: key.NewBinding(
		key.WithKeys("pgdown"),
		key.WithHelp("pgdown", "scroll down"),
	),
	Threads: key.NewBinding(
		key.WithKeys("ctrl+t"),
		key.WithHelp("ctrl+t", "threads"),
	),
	Models: key.NewBinding(
		key.WithKeys("ctrl+o"),
		key.WithHelp("ctrl+o", "models"),
	),
	Palette: key.NewBinding(
		key.WithKeys("ctrl+p"),
		key.WithHelp("ctrl+p", "command palette"),
	),
	Rewind: key.NewBinding(
		key.WithKeys("esc"),
		key.WithHelp("esc esc", "rewind most recent turn"),
	),
}

// ApprovalKeyMap is the approval dialog's bindings -- y/n/a, Appendix B's
// own vocabulary ("Approve once / deny / always allow"). Deliberately no
// Esc: the plan renders this dialog "as though it were blocking" (§2.4),
// and the turn really is suspended server-side until one of these three
// answers it -- there is nothing for Esc to cancel back to.
type ApprovalKeyMap struct {
	ApproveOnce   key.Binding
	ApproveAlways key.Binding
	Deny          key.Binding
}

var DefaultApprovalKeyMap = ApprovalKeyMap{
	ApproveOnce: key.NewBinding(
		key.WithKeys("y"),
		key.WithHelp("y", "approve once"),
	),
	ApproveAlways: key.NewBinding(
		key.WithKeys("a"),
		key.WithHelp("a", "always allow"),
	),
	Deny: key.NewBinding(
		key.WithKeys("n"),
		key.WithHelp("n", "deny"),
	),
}

// PickerKeyMap is shared by the thread switcher and the model picker: move,
// pick, filter by typing, leave.
type PickerKeyMap struct {
	Up     key.Binding
	Down   key.Binding
	Select key.Binding
	Cancel key.Binding
	Delete key.Binding // threads only; models ignores it
}

var DefaultPickerKeyMap = PickerKeyMap{
	Up:     key.NewBinding(key.WithKeys("up", "ctrl+k"), key.WithHelp("↑", "up")),
	Down:   key.NewBinding(key.WithKeys("down", "ctrl+j"), key.WithHelp("↓", "down")),
	Select: key.NewBinding(key.WithKeys("enter"), key.WithHelp("enter", "select")),
	Cancel: key.NewBinding(key.WithKeys("esc"), key.WithHelp("esc", "cancel")),
	Delete: key.NewBinding(key.WithKeys("ctrl+d"), key.WithHelp("ctrl+d", "delete")),
}
