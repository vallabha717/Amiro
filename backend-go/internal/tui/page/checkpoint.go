package page

import (
	"context"
	"encoding/json"

	tea "github.com/charmbracelet/bubbletea"

	"amiro/backend/internal/tui/client"
)

// rewindCandidateMsg carries loadRewindCandidate's result back into Update.
type rewindCandidateMsg struct {
	turnID string
	files  []client.CheckpointFile
	err    error
}

// loadRewindCandidate resolves "the most recent turn with checkpoints" for
// the open thread -- /rewind and Esc-Esc both fire this. An empty turnID
// (with no files) means there is nothing to rewind, rendered as that state
// explicitly by updateRewindCandidate rather than an empty confirmation
// dialog (docs/coding-agent-parity/phases/phase-01-checkpoints-and-rewind.md
// exit criterion 3).
func (m Chat) loadRewindCandidate() tea.Msg {
	turnID, files, err := m.c.LatestCheckpoint(context.Background(), m.state.ThreadID)
	return rewindCandidateMsg{turnID: turnID, files: files, err: err}
}

// rewindRestoredMsg carries restoreRewind's result back into Update.
type rewindRestoredMsg struct {
	results []client.CheckpointRestoreResult
	err     error
}

// restoreRewind is the human's "yes" answer to the rewind confirmation.
func (m Chat) restoreRewind() tea.Msg {
	results, err := m.c.RestoreCheckpoint(context.Background(), m.state.ThreadID, m.rewindTurnID)
	return rewindRestoredMsg{results: results, err: err}
}

// rewindFileInput is one line of the confirmation's file list.
type rewindFileInput struct {
	Path          string `json:"path"`
	ExistedBefore bool   `json:"existedBefore"`
}

// rewindPromptInput renders as the dialog's "what's about to happen, from
// input alone" preview -- the exact files that revert and whether each
// existed before the turn, the same information the web confirmation
// shows.
func rewindPromptInput(files []client.CheckpointFile) json.RawMessage {
	list := make([]rewindFileInput, len(files))
	for i, f := range files {
		list[i] = rewindFileInput{Path: f.Path, ExistedBefore: f.ExistedBefore}
	}
	b, _ := json.Marshal(map[string]any{"files": list})
	return b
}
