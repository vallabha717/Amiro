package tools

import (
	"context"
	"encoding/json"
	"testing"
)

func todoDefs(t *testing.T) (Definition, Definition) {
	t.Helper()
	defs := Defaults(Deps{Todos: NewTodoStore(), SessionID: "thread-1"})
	w, ok := FindByName(defs, NameTodoWrite)
	if !ok {
		t.Fatal("todo_write not in Defaults")
	}
	r, ok := FindByName(defs, NameTodoRead)
	if !ok {
		t.Fatal("todo_read not in Defaults")
	}
	return w, r
}

func writeTodos(t *testing.T, w Definition, items []map[string]any) TodoList {
	t.Helper()
	raw, _ := json.Marshal(map[string]any{"items": items})
	out, err := w.Execute(context.Background(), raw)
	if err != nil {
		t.Fatalf("todo_write: %v", err)
	}
	list, ok := out.(TodoList)
	if !ok {
		t.Fatalf("got %T, want TodoList", out)
	}
	return list
}

// The plan tools are the one place a "write" must not prompt. An agent
// revising its plan eight times producing eight approval cards would make
// the feature unusable and teach the user to click through cards unread.
func TestTodoTools_AreNotGatedButNeverRunInParallel(t *testing.T) {
	w, r := todoDefs(t)

	if w.Risk.Consequential() {
		t.Fatal("todo_write is consequential -- it would produce an approval card on every plan update")
	}
	if w.Concurrency() != Sequential {
		t.Fatal("todo_write is parallel -- two writes to one list race, and last-write-wins drops half the plan")
	}
	if r.Concurrency() != Parallel {
		t.Fatal("todo_read should be parallel-safe like any other read")
	}
}

func TestTodoWrite_ReplacesTheListAndCountsIt(t *testing.T) {
	w, r := todoDefs(t)

	list := writeTodos(t, w, []map[string]any{
		{"content": "read the loop", "status": "done"},
		{"content": "add the gate", "status": "in_progress"},
		{"content": "write tests", "status": "pending"},
		{"content": "update docs", "status": "pending"},
	})
	if list.Done != 1 || list.InProgress != 1 || list.Pending != 2 {
		t.Fatalf("counts = done %d / in_progress %d / pending %d, want 1/1/2",
			list.Done, list.InProgress, list.Pending)
	}

	// A write replaces; it does not merge. Anything else and the model has
	// no way to remove an item it decided against.
	list = writeTodos(t, w, []map[string]any{{"content": "only this", "status": "pending"}})
	if len(list.Items) != 1 || list.Items[0].Content != "only this" {
		t.Fatalf("items = %+v, want the list replaced wholesale", list.Items)
	}

	out, err := r.Execute(context.Background(), json.RawMessage(`{}`))
	if err != nil {
		t.Fatalf("todo_read: %v", err)
	}
	if got := out.(TodoList); len(got.Items) != 1 {
		t.Fatalf("todo_read returned %d items, want the 1 just written", len(got.Items))
	}
}

// A warning, not a rejection: the one-in-progress rule keeps the model
// focused, and throwing away an otherwise-good plan over bookkeeping is a
// worse trade than letting it fix itself on the next write.
func TestTodoWrite_WarnsOnMultipleInProgressWithoutRejecting(t *testing.T) {
	w, _ := todoDefs(t)
	list := writeTodos(t, w, []map[string]any{
		{"content": "a", "status": "in_progress"},
		{"content": "b", "status": "in_progress"},
	})
	if list.Notice == "" {
		t.Fatal("expected a notice about two in_progress items")
	}
	if len(list.Items) != 2 {
		t.Fatalf("items = %d, want the write to have been accepted anyway", len(list.Items))
	}
}

func TestTodoWrite_RejectsAnUnknownStatus(t *testing.T) {
	w, _ := todoDefs(t)
	raw, _ := json.Marshal(map[string]any{
		"items": []map[string]any{{"content": "a", "status": "blocked"}},
	})
	if _, err := w.Execute(context.Background(), raw); err == nil {
		t.Fatal("got nil error for status \"blocked\", want a rejection naming the valid values")
	}
}

// The session is bound at construction and is not a tool parameter -- a
// tool the model can point at a conversation id can read another
// conversation's plan by guessing one.
func TestTodoTools_AreScopedToTheirSession(t *testing.T) {
	store := NewTodoStore()
	one, _ := FindByName(Defaults(Deps{Todos: store, SessionID: "thread-1"}), NameTodoWrite)
	writeTodos(t, one, []map[string]any{{"content": "thread one's plan", "status": "pending"}})

	other, _ := FindByName(Defaults(Deps{Todos: store, SessionID: "thread-2"}), NameTodoRead)
	out, err := other.Execute(context.Background(), json.RawMessage(`{}`))
	if err != nil {
		t.Fatalf("todo_read: %v", err)
	}
	if got := out.(TodoList); len(got.Items) != 0 {
		t.Fatalf("thread-2 sees %d items from thread-1", len(got.Items))
	}

	var schema struct {
		Properties map[string]json.RawMessage `json:"properties"`
	}
	_ = json.Unmarshal(one.ParametersSchema, &schema)
	for _, banned := range []string{"session", "sessionId", "thread", "threadId"} {
		if _, ok := schema.Properties[banned]; ok {
			t.Fatalf("todo_write exposes %q as a parameter -- the model must not be able to name a session", banned)
		}
	}
}

// No session means no tools, rather than one shared global list.
func TestTodoTools_AbsentWithoutASession(t *testing.T) {
	if _, ok := FindByName(Defaults(Deps{Todos: NewTodoStore()}), NameTodoWrite); ok {
		t.Fatal("todo_write offered with no session id")
	}
	if _, ok := FindByName(Defaults(Deps{SessionID: "thread-1"}), NameTodoWrite); ok {
		t.Fatal("todo_write offered with no store")
	}
}
