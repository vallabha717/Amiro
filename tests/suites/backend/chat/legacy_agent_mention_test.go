package chat_test

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"testing"

	"amiro/tests/harness"
	"amiro/tests/harness/fakeprovider"
)

// TestChat_LegacyAgentMentionIsIgnoredNotPanicked is Phase 6's (docs/skills/)
// compatibility gate for the one stale-client case that matters: a client
// built before this phase still sends {"type":"agent","agentId":"..."} in
// its mentions array (mentionDTO.AgentID and the "agent" mention branch
// were both removed from route.go/mentions.go in this phase, but nothing
// stops an old browser tab or a cached desktop build from sending the old
// shape).
//
// apiclient.Mention has no AgentID field anymore -- deliberately, since the
// wire type should not carry a value the server can no longer read -- so
// this test builds the raw JSON body itself, the same way a stale client's
// request would actually look on the wire.
//
// What "safe" means here is deliberately NOT "returns a 400": every other
// unrecognized or inaccessible mention in this codebase is silently
// ignored rather than rejected (mentions.go's loadMCPTools/
// resolveSkills all skip a mention whose type they don't recognize, and the
// deleted resolveAgent's own doc comment said as much for an unknown or
// inaccessible agent id: "no error surfaced to the chat request either
// way"). Introducing a special 400 just for the one string "agent" would be
// inconsistent with that established contract, so the correctness bar is
// the same as for any other unmodeled mention: the turn completes, the
// unrecognized mention is silently dropped, and the server does not panic.
func TestChat_LegacyAgentMentionIsIgnoredNotPanicked(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"), harness.WithFake(func(s *fakeprovider.Server) {
		s.OnPrompt(fakeprovider.Contains("legacy agent mention probe")).
			StreamText("legacy mention handled.")
	}))
	be := h.Backend()
	user := h.As("user")

	payload, err := json.Marshal(map[string]any{
		"id": "thread-legacy-agent-mention",
		"message": map[string]any{
			"id":   "msg-1",
			"role": "user",
			"parts": []map[string]any{
				{"type": "text", "text": "legacy agent mention probe"},
			},
		},
		"toolChoice": "auto",
		"mentions": []map[string]any{
			{"type": "agent", "name": "Old Agent", "agentId": "agent-that-no-longer-exists"},
		},
		"workspaceRoot": be.WorkspaceRoot,
	})
	if err != nil {
		t.Fatalf("marshal request: %v", err)
	}

	httpReq, err := http.NewRequestWithContext(t.Context(), http.MethodPost, be.URL+"/api/chat", bytes.NewReader(payload))
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Accept", "text/event-stream")
	httpReq.Header.Set("X-Amiro-Token", be.Token)
	httpReq.Header.Set("Authorization", "Bearer "+user.Session)

	resp, err := http.DefaultClient.Do(httpReq)
	if err != nil {
		t.Fatalf("POST /api/chat with a legacy agent mention: %v", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("reading response body: %v", err)
	}

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200 (a legacy mention type should be silently ignored, not rejected); body:\n%s", resp.StatusCode, body)
	}
	// The reply streams as several text-delta chunks ("legacy ", "mention ",
	// "handled."), not one contiguous line, so check for the frames that
	// prove the turn actually finished rather than the exact joined text.
	if !bytes.Contains(body, []byte(`"type":"finish"`)) || !bytes.Contains(body, []byte("[DONE]")) {
		t.Fatalf("turn did not complete normally with a legacy agent mention present; body:\n%s", body)
	}
}
