package chat

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"testing"

	"gorm.io/datatypes"

	bifrostai "amiro/backend/internal/ai/bifrost"
	"amiro/backend/internal/ai/uimessage"
	"amiro/backend/internal/db/models"
)

// TestConsumeForceCompact_IsConsumedExactlyOnce guards the mechanism
// WithForceCompact/consumeForceCompact are built on: a multi-step turn must
// force-compact its first check only, never every step -- repeatedly
// summarizing an already-summarized history on every step of a long turn
// would be both wasteful and wrong.
func TestConsumeForceCompact_IsConsumedExactlyOnce(t *testing.T) {
	ctx := WithForceCompact(context.Background(), true)

	if !consumeForceCompact(ctx) {
		t.Fatalf("first consumeForceCompact = false, want true")
	}
	if consumeForceCompact(ctx) {
		t.Fatalf("second consumeForceCompact = true, want false -- the flag must be consumed once")
	}
}

// TestConsumeForceCompact_FalseWhenNeverSet covers the zero-behavior
// guarantee: a ctx nobody called WithForceCompact on (every existing caller,
// today) must not force anything.
func TestConsumeForceCompact_FalseWhenNeverSet(t *testing.T) {
	if consumeForceCompact(context.Background()) {
		t.Fatalf("consumeForceCompact on a plain context = true, want false")
	}
	if consumeForceCompact(WithForceCompact(context.Background(), false)) {
		t.Fatalf("consumeForceCompact after WithForceCompact(ctx, false) = true, want false")
	}
}

// compactAwareEngine distinguishes the compaction summarizer's call
// (summarizerFor passes empty StepHooks -- OnTextDelta is nil) from the
// turn's real model step, so a test can supply a real reply for the latter
// without a nil-hook panic from the former. textEngine (runner_test.go)
// unconditionally calls hooks.OnTextDelta and would panic if reused as the
// summarizer here.
type compactAwareEngine struct{ reply string }

func (e compactAwareEngine) Stream(context.Context, bifrostai.ResolvedModel, string, []bifrostai.Message) (<-chan bifrostai.Chunk, error) {
	ch := make(chan bifrostai.Chunk)
	close(ch)
	return ch, nil
}

func (e compactAwareEngine) StreamStep(_ context.Context, _ bifrostai.ResolvedModel, _ string, _ []bifrostai.Message, _ []bifrostai.ToolSpec, hooks bifrostai.StepHooks) (*bifrostai.StepResult, error) {
	if hooks.OnTextDelta == nil {
		return &bifrostai.StepResult{Text: "summary of the earlier conversation"}, nil
	}
	hooks.OnTextDelta(e.reply)
	return &bifrostai.StepResult{Text: e.reply, Usage: &bifrostai.Usage{PromptTokens: 5, CompletionTokens: 3, TotalTokens: 8}}, nil
}

// seedLongHistory inserts n short user/assistant message pairs directly,
// bypassing RunTurn -- compaction.Compact's own "nothing to compact" guard
// (len(messages) <= KeepRecent+1, KeepRecent=12) only clears once a thread
// has real history to work with, and building that through RunTurn itself
// would need as many fake turns.
func seedLongHistory(t *testing.T, env runnerEnv, threadID string, pairs int) {
	t.Helper()
	if err := env.h.chats.InsertThread(context.Background(), &models.ChatThread{ID: threadID, UserID: env.user.ID}); err != nil {
		t.Fatalf("insert thread: %v", err)
	}
	for i := 0; i < pairs; i++ {
		text, _ := json.Marshal(fmt.Sprintf("message number %d", i))
		part := datatypes.JSON(`[{"type":"text","text":` + string(text) + `}]`)
		for _, role := range []string{"user", "assistant"} {
			id := fmt.Sprintf("%s-%d", role, i)
			if err := env.h.chats.UpsertMessage(context.Background(), &models.ChatMessage{
				ID: id, ThreadID: threadID, Role: role, Parts: part,
			}); err != nil {
				t.Fatalf("seed message %s: %v", id, err)
			}
		}
	}
}

// TestRunTurn_CompactNowForcesCompactionEvenUnderBudget is the backend half
// of the TUI's `/compact`: a turn with CompactNow set must compact a long
// thread's history immediately, not wait for it to actually exceed
// compaction.DefaultPolicy's 100k-token budget the way every other turn
// does.
func TestRunTurn_CompactNowForcesCompactionEvenUnderBudget(t *testing.T) {
	env := newRunnerEnv(t, compactAwareEngine{reply: "done"})
	seedLongHistory(t, env, "thread-1", 7) // 14 messages: over KeepRecent(12), nowhere near 100k tokens

	turn := NewTextTurn(env.user, "thread-1", "please compact now")
	turn.CompactNow = true

	result, err := env.h.RunTurn(context.Background(), turn, uimessage.NewWriter(httptest.NewRecorder()))
	if err != nil {
		t.Fatalf("RunTurn: %v", err)
	}

	after := env.messagesOf(t, "thread-1")
	last := after[len(after)-1]
	if last.ID != result.ResponseID {
		t.Fatalf("last message id = %q, want the turn's ResponseID %q", last.ID, result.ResponseID)
	}

	var sawCompactionMarker bool
	var parts []json.RawMessage
	if err := json.Unmarshal(last.Parts, &parts); err != nil {
		t.Fatalf("decode persisted parts: %v", err)
	}
	for _, raw := range parts {
		var p struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(raw, &p) == nil && p.Type == "data-"+compactionDataPart {
			sawCompactionMarker = true
		}
	}
	if !sawCompactionMarker {
		t.Fatalf("no data-%s part in the persisted turn -- /compact did not force compaction: %s", compactionDataPart, last.Parts)
	}
}

// TestRunTurn_WithoutCompactNow_DoesNotCompactAShortThread is the control:
// the same short-of-budget history, without CompactNow, must not compact --
// proving the forced test above is actually testing the force, not
// coincidentally hitting the real 100k-token threshold.
func TestRunTurn_WithoutCompactNow_DoesNotCompactAShortThread(t *testing.T) {
	env := newRunnerEnv(t, compactAwareEngine{reply: "done"})
	seedLongHistory(t, env, "thread-1", 7)

	turn := NewTextTurn(env.user, "thread-1", "just a normal message")

	if _, err := env.h.RunTurn(context.Background(), turn, uimessage.NewWriter(httptest.NewRecorder())); err != nil {
		t.Fatalf("RunTurn: %v", err)
	}

	after := env.messagesOf(t, "thread-1")
	last := after[len(after)-1]
	var parts []json.RawMessage
	if err := json.Unmarshal(last.Parts, &parts); err != nil {
		t.Fatalf("decode persisted parts: %v", err)
	}
	for _, raw := range parts {
		var p struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(raw, &p) == nil && p.Type == "data-"+compactionDataPart {
			t.Fatalf("a short thread without CompactNow compacted anyway: %s", last.Parts)
		}
	}
}
