package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
)

// maxTodoItems bounds one list. A plan longer than this is not a plan, it
// is the model narrating; and the list is re-sent to the model on every
// write, so an unbounded one is a context leak that grows with the turn.
const maxTodoItems = 40

// TodoStatus is one item's state. Three values, not four: "blocked" reads
// like a status but is really a note, and a model given it will park work
// there instead of either finishing it or telling the user why it cannot.
type TodoStatus string

const (
	TodoPending    TodoStatus = "pending"
	TodoInProgress TodoStatus = "in_progress"
	TodoDone       TodoStatus = "done"
)

func validTodoStatus(s TodoStatus) bool {
	return s == TodoPending || s == TodoInProgress || s == TodoDone
}

// TodoItem is one line of the plan.
type TodoItem struct {
	Content string     `json:"content"`
	Status  TodoStatus `json:"status"`
}

// TodoList is the whole list plus the counts the presenter's glance line
// needs ("4 done · 2 pending") without walking Items again.
type TodoList struct {
	Items      []TodoItem `json:"items"`
	Done       int        `json:"done"`
	InProgress int        `json:"in_progress"`
	Pending    int        `json:"pending"`
	Notice     string     `json:"notice,omitempty"`
}

func summarize(items []TodoItem) TodoList {
	out := TodoList{Items: items}
	for _, it := range items {
		switch it.Status {
		case TodoDone:
			out.Done++
		case TodoInProgress:
			out.InProgress++
		default:
			out.Pending++
		}
	}
	return out
}

// TodoStore holds one list per conversation.
//
// Per conversation, and in memory. The list is working state for a turn --
// "what I am doing right now" -- not a durable artifact of it; the
// transcript already records what actually happened, which is the thing
// worth keeping. Persisting the plan too would create a second, divergent
// record of the same run, and the interesting question ("did it finish?")
// is answerable from the transcript either way.
type TodoStore struct {
	mu    sync.RWMutex
	lists map[string][]TodoItem
}

func NewTodoStore() *TodoStore { return &TodoStore{lists: map[string][]TodoItem{}} }

func (s *TodoStore) get(session string) []TodoItem {
	if s == nil {
		return nil
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	// Copied out: the caller marshals this into a tool result while another
	// request may be writing the same session's list.
	return append([]TodoItem(nil), s.lists[session]...)
}

func (s *TodoStore) set(session string, items []TodoItem) {
	if s == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lists[session] = items
}

type todoWriteInput struct {
	Items []TodoItem `json:"items"`
}

// todoTools returns the plan-tracking toolkit for one conversation.
//
// Bound to a session at construction rather than taking a session argument,
// because the model must not be able to name one: a tool whose parameters
// include "which conversation" is a tool that can read another
// conversation's state by guessing an id.
func todoTools(store *TodoStore, session string) []Definition {
	if store == nil || session == "" {
		return nil
	}

	return []Definition{
		{
			Name:    NameTodoWrite,
			Toolkit: ToolkitTodo,
			// Session risk: no prompt (a plan revised eight times must not
			// produce eight approval cards) but never parallel (two writes
			// to one list race).
			Risk: RiskSession,
			Description: "Record or update your plan for a multi-step task. Send the WHOLE list every " +
				"time -- this replaces the previous one, it does not merge. Keep exactly one item " +
				"in_progress. Write the plan before starting work, and mark each item done as you " +
				"finish it rather than in a batch at the end.",
			ParametersSchema: json.RawMessage(`{
				"type": "object",
				"properties": {
					"items": {
						"type": "array",
						"description": "The complete list, in order.",
						"items": {
							"type": "object",
							"properties": {
								"content": {"type": "string", "description": "What needs doing, as an imperative."},
								"status": {"type": "string", "enum": ["pending", "in_progress", "done"]}
							},
							"required": ["content", "status"],
							"additionalProperties": false
						}
					}
				},
				"required": ["items"],
				"additionalProperties": false
			}`),
			Execute: func(ctx context.Context, raw json.RawMessage) (any, error) {
				var in todoWriteInput
				if err := json.Unmarshal(raw, &in); err != nil {
					return nil, fmt.Errorf("todo_write: %w", err)
				}
				if len(in.Items) > maxTodoItems {
					return nil, fmt.Errorf("todo_write: %d items, over the %d limit -- break the task down at a coarser grain",
						len(in.Items), maxTodoItems)
				}

				cleaned := make([]TodoItem, 0, len(in.Items))
				inProgress := 0
				for _, it := range in.Items {
					content := strings.TrimSpace(it.Content)
					if content == "" {
						continue
					}
					if !validTodoStatus(it.Status) {
						return nil, fmt.Errorf("todo_write: %q has status %q; expected pending, in_progress or done",
							content, it.Status)
					}
					if it.Status == TodoInProgress {
						inProgress++
					}
					cleaned = append(cleaned, TodoItem{Content: content, Status: it.Status})
				}

				store.set(session, cleaned)
				out := summarize(cleaned)
				// A warning, not an error. The one-in-progress rule is there
				// to keep the model focused, and rejecting the write would
				// throw away a plan that is otherwise fine over a matter of
				// bookkeeping -- the model can fix it on the next write.
				if inProgress > 1 {
					out.Notice = fmt.Sprintf("%d items are in_progress; work on one at a time", inProgress)
				}
				return out, nil
			},
		},
		{
			Name:             NameTodoRead,
			Toolkit:          ToolkitTodo,
			Risk:             RiskRead,
			Description:      "Read your current plan. Use this after a long stretch of work to check what is left.",
			ParametersSchema: json.RawMessage(`{"type": "object", "properties": {}, "additionalProperties": false}`),
			Execute: func(ctx context.Context, raw json.RawMessage) (any, error) {
				return summarize(store.get(session)), nil
			},
		},
	}
}
