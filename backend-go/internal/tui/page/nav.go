package page

import "amiro/backend/internal/tui/client"

// Navigation messages route between pages through app.Model -- the plan's
// Part 3 puts thread/model routing at the app level ("app/update.go: message
// dispatch"), and these are the vocabulary that dispatch understands. They
// live in this package (not app's) so page.Chat, page.Threads and
// page.Models can all emit and read them without app importing any of them
// for their type alone, and without a page importing a sibling page.

// OpenThreadsMsg asks app.Model to switch to the thread switcher --
// Ctrl+T or "/threads".
type OpenThreadsMsg struct{}

// OpenRunsMsg asks app.Model to switch to the background-run picker --
// "/runs" (docs/coding-agent-parity/05-background-agent-runs.md). It has no
// dedicated ChosenMsg of its own: picking a run resolves to the exact same
// ThreadChosenMsg Threads emits, since "resume a run" and "resume a
// thread" are the same operation -- a suspended run's pending approval is
// an ordinary part on its thread, not a second kind of state.
type OpenRunsMsg struct{}

// OpenModelsMsg asks app.Model to switch to the model picker -- Ctrl+O or
// "/models".
type OpenModelsMsg struct{}

// OpenSettingsMsg asks app.Model to switch to the settings page --
// "/settings".
type OpenSettingsMsg struct{}

// ThreadChosenMsg reports that Threads resumed a thread -- app.Model loads
// Detail into Chat and switches back.
type ThreadChosenMsg struct {
	Detail client.ThreadDetail
}

// ModelChosenMsg reports that Models picked a provider/model -- app.Model
// applies it to Chat and switches back.
type ModelChosenMsg struct {
	Provider string
	Model    string
}

// PickerCancelledMsg reports Esc from either picker with nothing chosen --
// app.Model switches back to Chat unchanged.
type PickerCancelledMsg struct{}
