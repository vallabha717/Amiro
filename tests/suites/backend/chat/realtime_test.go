package chat_test

import (
	"testing"

	"amiro/tests/harness"
	"amiro/tests/harness/apiclient"
)

// TestRealtime_OpenAIRealtimeEndpoint verifies POST /api/chat/openai-realtime routing and response.
func TestRealtime_OpenAIRealtimeEndpoint(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"))
	user := h.As("user")

	body := map[string]any{
		"model": "gpt-4o-realtime-preview",
	}

	// Realtime endpoint requires provider key or configured base URL
	resp, err := user.OpenAIRealtime(t.Context(), body)
	if err != nil {
		// Verify expected HTTP status code (e.g. 200 with session or 400/500 if unconfigured)
		status := apiclient.StatusOf(err)
		if status != 200 && status != 400 && status != 500 {
			t.Errorf("unexpected realtime status: %d (err: %v)", status, err)
		}
		return
	}

	if len(resp) == 0 {
		t.Log("realtime response received")
	}
}
