package cassette_test

import (
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"amiro/tests/harness/cassette"
)

func TestCassette_NormalizeAndMatch(t *testing.T) {
	body1 := []byte(`{"model":"gpt-4.1","messages":[{"role":"user","content":"hello"}],"max_tokens":100,"stream_options":{"include_usage":true}}`)
	body2 := []byte(`{"messages":[{"role":"user","content":"hello"}],"model":"gpt-4.1"}`)

	norm1, err := cassette.Normalize("POST", "/v1/chat/completions", body1)
	if err != nil {
		t.Fatalf("Normalize 1: %v", err)
	}
	norm2, err := cassette.Normalize("POST", "/v1/chat/completions", body2)
	if err != nil {
		t.Fatalf("Normalize 2: %v", err)
	}

	if norm1 != norm2 {
		t.Errorf("normalized bodies should match regardless of key order, max_tokens, and stream_options:\n1: %s\n2: %s", norm1, norm2)
	}
}

func TestCassette_NormalizeDynamicTokensAndPrompts(t *testing.T) {
	body1 := []byte(`{"messages":[{"role":"system","content":"Working directory: /home/user/workspace/app-12345\nToday is 2026-08-19\nYou are an assistant"},{"role":"tool","tool_call_id":"call_98765abcde","content":"file at /tmp/scratch/file-550e8400-e29b-41d4-a716-446655440000.txt"}]}`)
	body2 := []byte(`{"messages":[{"role":"system","content":"Working directory: /var/runner/workspace/app-99999\nToday is 2026-12-31\nYou are an assistant"},{"role":"tool","tool_call_id":"call_12345zzzzz","content":"file at /tmp/scratch/file-12345678-1234-1234-1234-123456789abc.txt"}]}`)

	norm1, err := cassette.Normalize("POST", "/v1/chat/completions", body1)
	if err != nil {
		t.Fatalf("Normalize 1: %v", err)
	}
	norm2, err := cassette.Normalize("POST", "/v1/chat/completions", body2)
	if err != nil {
		t.Fatalf("Normalize 2: %v", err)
	}

	if norm1 != norm2 {
		t.Errorf("dynamic system prompt, path, date, call_id and UUID normalization should produce identical hash:\n1: %s\n2: %s", norm1, norm2)
	}
}

func TestCassette_StoreAndReplay(t *testing.T) {
	tempDir := t.TempDir()
	store := cassette.NewStore(tempDir)

	c := &cassette.Cassette{
		Meta: cassette.Meta{
			Recorded: time.Now(),
			Provider: "openai",
			Model:    "gpt-4.1",
			TTLDays:  90,
		},
		Interactions: []cassette.Interaction{
			{
				Request: cassette.Request{
					Method: "POST",
					Path:   "/v1/chat/completions",
					Body: map[string]any{
						"model":    "gpt-4.1",
						"messages": []map[string]any{{"role": "user", "content": "test message"}},
					},
				},
				Response: cassette.Response{
					Status: 200,
					Headers: map[string]string{
						"Content-Type": "text/event-stream",
					},
					Stream: []cassette.StreamChunk{
						{DelayMS: 5, Data: "data: {\"choices\":[{\"delta\":{\"content\":\"Hello \"}}]}\n\n"},
						{DelayMS: 5, Data: "data: {\"choices\":[{\"delta\":{\"content\":\"world!\"}}]}\n\n"},
						{DelayMS: 2, Data: "data: [DONE]\n\n"},
					},
				},
			},
		},
	}

	err := store.Save("chat/basic.yaml", c)
	if err != nil {
		t.Fatalf("saving cassette: %v", err)
	}

	// Reload from disk
	store2 := cassette.NewStore(tempDir)
	if err := store2.Load(); err != nil {
		t.Fatalf("loading cassette: %v", err)
	}

	reqBody := `{"model":"gpt-4.1","messages":[{"role":"user","content":"test message"}]}`
	matched, name, ok := store2.Match("chat/basic.yaml", "POST", "/v1/chat/completions", []byte(reqBody))
	if !ok {
		t.Fatalf("expected interaction to match")
	}
	if name != "chat/basic.yaml" {
		t.Errorf("expected cassette name chat/basic.yaml, got %s", name)
	}
	if len(matched.Response.Stream) != 3 {
		t.Errorf("expected 3 chunks, got %d", len(matched.Response.Stream))
	}
}

func TestCassette_ProxyReplayAndStrictMiss(t *testing.T) {
	tempDir := t.TempDir()
	store := cassette.NewStore(tempDir)

	c := &cassette.Cassette{
		Meta: cassette.Meta{Recorded: time.Now(), Provider: "openai", Model: "gpt-4.1", TTLDays: 90},
		Interactions: []cassette.Interaction{
			{
				Request: cassette.Request{
					Method: "POST",
					Path:   "/chat/completions",
					Body: map[string]any{
						"model":    "gpt-4.1",
						"messages": []map[string]any{{"role": "user", "content": "ping"}},
					},
				},
				Response: cassette.Response{
					Status:  200,
					Headers: map[string]string{"Content-Type": "application/json"},
					Body: map[string]any{
						"choices": []map[string]any{
							{"message": map[string]any{"role": "assistant", "content": "pong"}},
						},
					},
				},
			},
		},
	}
	_ = store.Save("test.yaml", c)

	// Strict replay proxy
	proxy := cassette.NewProxy(cassette.ProxyOptions{
		Mode:            "replay",
		StrictCassettes: true,
		CassetteDir:     tempDir,
	})
	defer proxy.Close()

	// 1. Hit matching request
	respMatch, err := http.Post(proxy.URL+"/chat/completions", "application/json", strings.NewReader(`{"model":"gpt-4.1","messages":[{"role":"user","content":"ping"}]}`))
	if err != nil {
		t.Fatalf("POST matching: %v", err)
	}
	defer respMatch.Body.Close()
	if respMatch.StatusCode != http.StatusOK {
		t.Errorf("expected 200, got %d", respMatch.StatusCode)
	}
	b, _ := io.ReadAll(respMatch.Body)
	if !strings.Contains(string(b), "pong") {
		t.Errorf("expected 'pong', got %s", string(b))
	}

	// 2. Hit non-matching request (should fail 500 under strictCassettes: true)
	respMiss, err := http.Post(proxy.URL+"/chat/completions", "application/json", strings.NewReader(`{"model":"gpt-4.1","messages":[{"role":"user","content":"unrecorded"}]}`))
	if err != nil {
		t.Fatalf("POST miss: %v", err)
	}
	defer respMiss.Body.Close()
	if respMiss.StatusCode != http.StatusInternalServerError {
		t.Errorf("expected 500 on strict miss, got %d", respMiss.StatusCode)
	}
	missBody, _ := io.ReadAll(respMiss.Body)
	if !strings.Contains(string(missBody), "Cassette miss") {
		t.Errorf("expected cassette miss error message, got %s", string(missBody))
	}
}

func TestCassette_TTLCheck(t *testing.T) {
	tempDir := t.TempDir()
	now := time.Now()

	fresh := &cassette.Cassette{
		Meta: cassette.Meta{Recorded: now.Add(-10 * 24 * time.Hour), TTLDays: 90},
	}
	stale := &cassette.Cassette{
		Meta: cassette.Meta{Recorded: now.Add(-100 * 24 * time.Hour), TTLDays: 90},
	}

	store := cassette.NewStore(tempDir)
	_ = store.Save("fresh.yaml", fresh)
	_ = store.Save("stale.yaml", stale)

	reports, err := cassette.CheckTTL(tempDir, now)
	if err != nil {
		t.Fatalf("CheckTTL: %v", err)
	}

	if len(reports) != 2 {
		t.Fatalf("expected 2 reports, got %d", len(reports))
	}

	for _, r := range reports {
		if filepath.Base(r.Path) == "stale.yaml" {
			if !r.IsExpired {
				t.Errorf("expected stale.yaml to be expired")
			}
		}
		if filepath.Base(r.Path) == "fresh.yaml" {
			if r.IsExpired {
				t.Errorf("expected fresh.yaml not to be expired")
			}
		}
	}
}

func TestCassette_CostAccounting(t *testing.T) {
	tracker := cassette.NewCostTracker("replay")
	tracker.RecordUsage("gpt-4.1", 100, 200)
	rep := tracker.Report()

	if rep.EstimatedCostUSD != 0.00 {
		t.Errorf("replay mode cost must be 0.00, got %f", rep.EstimatedCostUSD)
	}
	if rep.TotalTokens != 300 {
		t.Errorf("expected total tokens 300, got %d", rep.TotalTokens)
	}

	tempFile := filepath.Join(t.TempDir(), "providers", "cost.json")
	if err := tracker.WriteJSON(tempFile); err != nil {
		t.Fatalf("WriteJSON: %v", err)
	}

	data, _ := os.ReadFile(tempFile)
	if !strings.Contains(string(data), `"estimatedCostUsd": 0`) {
		t.Errorf("cost.json must write 0 cost for replay: %s", string(data))
	}
}

func TestCassette_RecordAndReplayByteIdentical(t *testing.T) {
	tempDir := t.TempDir()
	cassetteFile := "record_replay_e2e.yaml"

	// 1. Initial cassette with a deterministic stream
	expectedPayload := "data: {\"choices\":[{\"delta\":{\"content\":\"Deterministic token stream output.\"}}]}\n\ndata: [DONE]\n\n"
	c := &cassette.Cassette{
		Meta: cassette.Meta{
			Recorded: time.Now(),
			Provider: "openai",
			Model:    "gpt-4.1",
			TTLDays:  90,
		},
		Interactions: []cassette.Interaction{
			{
				Request: cassette.Request{
					Method: "POST",
					Path:   "/chat/completions",
					Body: map[string]any{
						"model":    "gpt-4.1",
						"messages": []map[string]any{{"role": "user", "content": "test e2e fidelity"}},
					},
				},
				Response: cassette.Response{
					Status:  200,
					Headers: map[string]string{"Content-Type": "text/event-stream"},
					Stream: []cassette.StreamChunk{
						{DelayMS: 0, Data: expectedPayload},
					},
				},
			},
		},
	}

	store := cassette.NewStore(tempDir)
	if err := store.Save(cassetteFile, c); err != nil {
		t.Fatalf("saving cassette: %v", err)
	}

	// 2. Start replay proxy
	proxy := cassette.NewProxy(cassette.ProxyOptions{
		Mode:              "replay",
		StrictCassettes:   true,
		CassetteDir:       tempDir,
		PreferredCassette: cassetteFile,
	})
	defer proxy.Close()

	// 3. Make HTTP request through proxy and collect raw bytes
	reqBody := `{"model":"gpt-4.1","messages":[{"role":"user","content":"test e2e fidelity"}]}`
	resp, err := http.Post(proxy.URL+"/chat/completions", "application/json", strings.NewReader(reqBody))
	if err != nil {
		t.Fatalf("POST through replay proxy: %v", err)
	}
	defer resp.Body.Close()

	replayedBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("reading response bytes: %v", err)
	}

	// 4. Assert byte-identical stream response
	if string(replayedBytes) != expectedPayload {
		t.Fatalf("byte-level replay mismatch:\nGOT:\n%s\nWANT:\n%s", string(replayedBytes), expectedPayload)
	}
	t.Logf("End-to-end replay verified byte-identical (%d bytes matched exactly)", len(replayedBytes))
}
