package pty

import (
	"context"
	"testing"
	"time"
)

func TestWaitForText_FindsTextPromptly(t *testing.T) {
	b := NewBuffer(80, 24)
	go func() {
		<-time.After(30 * time.Millisecond)
		_, _ = b.Write([]byte("Ready to chat"))
	}()

	ctx := context.Background()
	if err := WaitForText(ctx, b, "Ready to chat", 2*time.Second); err != nil {
		t.Fatalf("WaitForText failed: %v", err)
	}
}

func TestWaitForStable_DetectsQuiescence(t *testing.T) {
	b := NewBuffer(80, 24)
	go func() {
		_, _ = b.Write([]byte("Streaming chunk 1..."))
		<-time.After(20 * time.Millisecond)
		_, _ = b.Write([]byte(" chunk 2..."))
		<-time.After(20 * time.Millisecond)
		_, _ = b.Write([]byte(" done."))
	}()

	ctx := context.Background()
	if err := WaitForStable(ctx, b, 2*time.Second, 40*time.Millisecond); err != nil {
		t.Fatalf("WaitForStable failed: %v", err)
	}
	if !b.Contains("done.") {
		t.Errorf("buffer should contain 'done.', got:\n%s", b.Plain())
	}
}
