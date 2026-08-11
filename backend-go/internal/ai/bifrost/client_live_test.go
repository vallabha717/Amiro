package bifrostai

import (
	"context"
	"os"
	"testing"
	"time"
)

// TestClient_StreamAgainstRealOpenAI is the Phase 3 home of Phase 0's spike
// (spike/bifrost/main.go, now deleted): the same proof that bifrost.Init +
// ChatCompletionStreamRequest work end to end against the real OpenAI API,
// now exercised through Client.Stream instead of a throwaway main(). Skips
// (not fails) without a real key, the same gating pattern
// internal/secrets/keyring_store_test.go and tests/migration use for
// environment-dependent scenarios.
func TestClient_StreamAgainstRealOpenAI(t *testing.T) {
	apiKey := os.Getenv("OPENAI_API_KEY")
	if apiKey == "" || len(apiKey) < 20 {
		t.Skip("OPENAI_API_KEY not set to a real key; skipping live Bifrost call")
	}

	store := fakeStore{"openai": apiKey}
	client, err := NewClient(context.Background(), store)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	defer client.Shutdown()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	resolved := Resolve("openai", "gpt-4.1-mini")
	chunks, err := client.Stream(ctx, resolved, "", []Message{
		{Role: RoleUser, Text: "Reply with exactly the word: pong"},
	})
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}

	var text string
	for chunk := range chunks {
		if chunk.Err != nil {
			t.Fatalf("stream chunk error: %v", chunk.Err)
		}
		text += chunk.TextDelta
	}
	if text == "" {
		t.Fatal("expected non-empty streamed text from a real OpenAI call")
	}
}
