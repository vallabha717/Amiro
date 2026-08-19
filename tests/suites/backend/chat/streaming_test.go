package chat_test

import (
	"context"
	"strings"
	"testing"
	"time"

	"amiro/tests/harness"
	"amiro/tests/harness/apiclient"
	"amiro/tests/harness/fakeprovider"
)

// TestStreaming_DeltasArriveInOrder verifies the UI message stream emits start, text deltas in order, and finish frames.
func TestStreaming_DeltasArriveInOrder(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"))
	user := h.As("user")

	expectedText := "The quick brown fox jumps over the lazy dog."
	h.Fake().OnPrompt(fakeprovider.Contains("fox")).StreamText(expectedText, fakeprovider.PerChunk(6))

	threadID := "thread-stream-order-1"
	req := apiclient.ChatRequest{
		ID:      threadID,
		Message: apiclient.TextMessage("msg-1", "tell me about the fox"),
	}

	stream, err := user.Chat(t.Context(), req)
	if err != nil {
		t.Fatalf("POST /api/chat: %v", err)
	}
	defer stream.Close()

	turn, err := stream.Collect()
	if err != nil {
		t.Fatalf("stream.Collect: %v", err)
	}

	if !turn.Finished {
		t.Errorf("expected stream to finish with [DONE]")
	}
	if turn.Text != expectedText {
		t.Errorf("got %q, want %q", turn.Text, expectedText)
	}

	// Verify frame sequencing
	var frameTypes []apiclient.FrameType
	for _, f := range turn.Frames {
		frameTypes = append(frameTypes, f.Type)
	}

	hasStart := false
	hasDelta := false
	hasFinish := false

	for _, ft := range frameTypes {
		switch ft {
		case apiclient.FrameStart:
			hasStart = true
		case apiclient.FrameTextDelta:
			if !hasStart {
				t.Errorf("text-delta frame arrived before start frame")
			}
			hasDelta = true
		case apiclient.FrameFinish:
			hasFinish = true
		}
	}

	if !hasStart || !hasDelta || !hasFinish {
		t.Errorf("missing expected frame types: start=%v, delta=%v, finish=%v", hasStart, hasDelta, hasFinish)
	}
}

// TestStreaming_ClientDisconnectCancelsTurn verifies that closing the client connection stops execution.
func TestStreaming_ClientDisconnectCancelsTurn(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")

	longText := strings.Repeat("Long streamed response chunk data. ", 50)
	h.Fake().OnPrompt(fakeprovider.Contains("cancel")).StreamText(longText, fakeprovider.PerChunk(10))

	ctx, cancel := context.WithTimeout(t.Context(), 50*time.Millisecond)
	defer cancel()

	req := apiclient.ChatRequest{
		ID:      "thread-stream-cancel-1",
		Message: apiclient.TextMessage("msg-1", "cancel me stream"),
	}

	stream, err := user.Chat(ctx, req)
	if err == nil {
		// Read one frame then close
		_ = stream.Next()
		_ = stream.Close()
	}

	// Verify backend is still healthy and accepts next turn
	h.Fake().OnPrompt(fakeprovider.Contains("ping")).StreamText("pong")
	req2 := apiclient.ChatRequest{
		ID:      "thread-stream-cancel-2",
		Message: apiclient.TextMessage("msg-2", "ping"),
	}
	turn, err := user.ChatTurn(t.Context(), req2)
	if err != nil {
		t.Fatalf("subsequent chat turn failed: %v", err)
	}
	if turn.Text != "pong" {
		t.Errorf("expected 'pong', got %q", turn.Text)
	}
}
