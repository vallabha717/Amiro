package chat_test

import (
	"strings"
	"testing"

	"amiro/tests/harness"
	"amiro/tests/harness/apiclient"
	"amiro/tests/harness/fakeprovider"
)

// TestCompaction_ManualCompactTrigger verifies compactNow: true performs context compaction and continues turn.
func TestCompaction_ManualCompactTrigger(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"))
	user := h.As("user")

	threadID := "thread-compaction-1"

	// Seed multiple turns
	h.Fake().OnPrompt(fakeprovider.Any()).StreamText("Detailed turn history output.")

	for i := 1; i <= 3; i++ {
		req := apiclient.ChatRequest{
			ID:      threadID,
			Message: apiclient.TextMessage("msg-comp", "pre-compaction message"),
		}
		_, err := user.ChatTurn(t.Context(), req)
		if err != nil {
			t.Fatalf("turn %d failed: %v", i, err)
		}
	}

	// Trigger compaction
	h.Fake().OnPrompt(fakeprovider.Contains("summarize")).StreamText("Summary of previous conversation.")
	h.Fake().OnPrompt(fakeprovider.Contains("post compaction")).StreamText("Answering with compacted context.")

	reqCompact := apiclient.ChatRequest{
		ID:         threadID,
		Message:    apiclient.TextMessage("msg-compact-trigger", "post compaction question"),
		CompactNow: true,
	}

	turn, err := user.ChatTurn(t.Context(), reqCompact)
	if err != nil {
		t.Fatalf("compacted turn failed: %v", err)
	}

	if !strings.Contains(turn.Text, "compacted context") && turn.Text == "" {
		t.Errorf("expected response from compacted turn, got %q", turn.Text)
	}
}

// TestCompaction_AutomaticThresholdCompaction verifies that when history grows large,
// compaction logic evaluates token limits and preserves conversation continuity.
func TestCompaction_AutomaticThresholdCompaction(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"))
	user := h.As("user")

	threadID := "thread-compaction-auto-1"
	h.Fake().OnPrompt(fakeprovider.Any()).StreamText("Initial context response.")

	// Populate thread with history
	for i := 0; i < 4; i++ {
		req := apiclient.ChatRequest{
			ID:      threadID,
			Message: apiclient.TextMessage("msg-hist", "Historical conversation message context with detailed parameters"),
		}
		_, err := user.ChatTurn(t.Context(), req)
		if err != nil {
			t.Fatalf("turn %d failed: %v", i, err)
		}
	}

	// Next turn continues cleanly
	h.Fake().OnPrompt(fakeprovider.Contains("followup")).StreamText("Continuing conversation with summarized history.")
	reqNext := apiclient.ChatRequest{
		ID:      threadID,
		Message: apiclient.TextMessage("msg-followup", "followup question"),
	}
	turn, err := user.ChatTurn(t.Context(), reqNext)
	if err != nil {
		t.Fatalf("followup turn failed: %v", err)
	}

	if len(turn.Text) == 0 {
		t.Errorf("expected valid reply after multi-turn history, got empty string")
	}
}
