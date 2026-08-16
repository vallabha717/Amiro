package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"amiro/backend/internal/agent/memory"
)

// maxMemorySearchResults bounds a read. The store caps at 200 short
// entries, so this is about keeping one tool call from re-injecting the
// whole store the system prompt already carries, not about scale.
const maxMemorySearchResults = 30

// MemoryWriteOutput is what the model and the presenter see after a write.
type MemoryWriteOutput struct {
	ID      string   `json:"id"`
	Text    string   `json:"text"`
	Tags    []string `json:"tags,omitempty"`
	Updated bool     `json:"updated"` // true when this reinforced an existing memory
	Total   int      `json:"total"`
	Path    string   `json:"path"`
}

// MemoryReadOutput is a search result set.
type MemoryReadOutput struct {
	Query   string         `json:"query,omitempty"`
	Entries []memory.Entry `json:"entries"`
	Total   int            `json:"total"`
	Path    string         `json:"path"`
	Notice  string         `json:"notice,omitempty"`
}

// MemoryForgetOutput reports a deletion.
type MemoryForgetOutput struct {
	ID      string `json:"id"`
	Removed bool   `json:"removed"`
	Total   int    `json:"total"`
}

type memoryWriteInput struct {
	Text string   `json:"text"`
	Tags []string `json:"tags"`
}

type memoryReadInput struct {
	Query string `json:"query"`
}

type memoryForgetInput struct {
	ID string `json:"id"`
}

// memoryTools returns the durable-notes toolkit for one workspace.
//
// Session is the thread id, recorded on each memory so a user who finds a
// wrong note can trace it back to the conversation that wrote it. As with
// the todo tools it is bound at construction and never a parameter: a tool
// the model can point at another conversation is one that can read another
// conversation by guessing an id.
func memoryTools(store *memory.Store, session string) []Definition {
	if store == nil {
		return nil
	}

	return []Definition{
		{
			Name:    NameMemoryWrite,
			Toolkit: ToolkitMemory,
			// Write, not Session. A todo affects this turn and the user
			// watches it happen; a memory silently changes every future
			// conversation about this workspace and shows up in no
			// transcript afterwards. See the package doc for the full
			// argument -- it is the one place the RiskSession reasoning
			// deliberately does not carry over.
			Risk: RiskWrite,
			Description: "Remember one durable fact about this workspace for future conversations -- a " +
				"build command, a convention, where something lives, a constraint the user stated. " +
				"Write it as a standalone sentence: you will read it back with none of this " +
				"conversation around it. Do NOT record what you did this turn (the transcript has " +
				"that), anything specific to the current task, or anything you have not verified.",
			ParametersSchema: json.RawMessage(`{
				"type": "object",
				"properties": {
					"text": {"type": "string", "description": "The fact, as one self-contained sentence."},
					"tags": {"type": "array", "items": {"type": "string"}, "description": "Optional keywords for later search, e.g. [\"build\", \"testing\"]."}
				},
				"required": ["text"],
				"additionalProperties": false
			}`),
			Execute: func(ctx context.Context, raw json.RawMessage) (any, error) {
				var in memoryWriteInput
				if err := json.Unmarshal(raw, &in); err != nil {
					return nil, fmt.Errorf("memory_write: %w", err)
				}
				before := len(store.All())
				e, err := store.Remember(in.Text, in.Tags, session)
				if err != nil {
					return nil, err
				}
				after := store.All()
				return MemoryWriteOutput{
					ID:      e.ID,
					Text:    e.Text,
					Tags:    e.Tags,
					Updated: len(after) == before,
					Total:   len(after),
					Path:    store.Path(),
				}, nil
			},
		},
		{
			Name:    NameMemoryRead,
			Toolkit: ToolkitMemory,
			Risk:    RiskRead,
			Description: "Search your notes about this workspace. Your most recent notes are already in " +
				"your system prompt -- use this only to look for something older than that, or to " +
				"find a note's id so you can correct or forget it.",
			ParametersSchema: json.RawMessage(`{
				"type": "object",
				"properties": {
					"query": {"type": "string", "description": "Words that must all appear in the note or its tags. Omit to list everything."}
				},
				"additionalProperties": false
			}`),
			Execute: func(ctx context.Context, raw json.RawMessage) (any, error) {
				var in memoryReadInput
				if len(raw) > 0 {
					_ = json.Unmarshal(raw, &in)
				}
				hits := store.Search(in.Query, maxMemorySearchResults)
				out := MemoryReadOutput{
					Query:   strings.TrimSpace(in.Query),
					Entries: hits,
					Total:   len(store.All()),
					Path:    store.Path(),
				}
				if len(hits) == 0 && out.Total > 0 {
					out.Notice = "no notes matched; there are notes, just none about this"
				}
				return out, nil
			},
		},
		{
			Name:    NameMemoryForget,
			Toolkit: ToolkitMemory,
			Risk:    RiskWrite,
			Description: "Delete a note you have found to be wrong or obsolete. Get its id from " +
				"memory_read. Prefer this over leaving a stale note in place: a wrong note is " +
				"worse than a missing one, because you will believe it.",
			ParametersSchema: json.RawMessage(`{
				"type": "object",
				"properties": {"id": {"type": "string", "description": "The note's id, from memory_read."}},
				"required": ["id"],
				"additionalProperties": false
			}`),
			Execute: func(ctx context.Context, raw json.RawMessage) (any, error) {
				var in memoryForgetInput
				if err := json.Unmarshal(raw, &in); err != nil {
					return nil, fmt.Errorf("memory_forget: %w", err)
				}
				removed, err := store.Forget(strings.TrimSpace(in.ID))
				if err != nil {
					return nil, err
				}
				return MemoryForgetOutput{ID: in.ID, Removed: removed, Total: len(store.All())}, nil
			},
		},
	}
}
