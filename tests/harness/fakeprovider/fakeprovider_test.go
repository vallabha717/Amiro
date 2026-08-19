package fakeprovider_test

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"amiro/tests/harness/fakeprovider"
)

func TestFakeProvider_StreamsTextOpenAI(t *testing.T) {
	s := fakeprovider.New()
	defer s.Close()

	s.OnPrompt(fakeprovider.Contains("hello")).StreamText("Hello there, friend!", fakeprovider.PerChunk(5))

	reqBody := `{"model":"gpt-4.1","stream":true,"messages":[{"role":"user","content":"say hello please"}]}`
	resp, err := http.Post(s.URL+"/v1/chat/completions", "application/json", strings.NewReader(reqBody))
	if err != nil {
		t.Fatalf("POST /v1/chat/completions: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}

	scanner := bufio.NewScanner(resp.Body)
	var textBuilder strings.Builder
	sawDone := false

	for scanner.Scan() {
		line := scanner.Text()
		if line == "data: [DONE]" {
			sawDone = true
			break
		}
		if strings.HasPrefix(line, "data: ") {
			data := strings.TrimPrefix(line, "data: ")
			var chunk struct {
				Choices []struct {
					Delta struct {
						Content string `json:"content"`
					} `json:"delta"`
				} `json:"choices"`
			}
			if err := json.Unmarshal([]byte(data), &chunk); err == nil && len(chunk.Choices) > 0 {
				textBuilder.WriteString(chunk.Choices[0].Delta.Content)
			}
		}
	}

	if err := scanner.Err(); err != nil {
		t.Fatalf("scanner error: %v", err)
	}
	if !sawDone {
		t.Errorf("expected [DONE] sentinel")
	}
	if textBuilder.String() != "Hello there, friend!" {
		t.Errorf("got %q, expected 'Hello there, friend!'", textBuilder.String())
	}
}

func TestFakeProvider_ToolCallThenStream(t *testing.T) {
	s := fakeprovider.New()
	defer s.Close()

	s.OnPrompt(fakeprovider.Exact("read readme")).
		ToolCall("read_file", map[string]any{"path": "README.md"}).
		ThenStreamText("The readme content is here.")

	// Step 1: initial user prompt
	req1 := `{"model":"gpt-4.1","stream":true,"messages":[{"role":"user","content":"read readme"}]}`
	resp1, err := http.Post(s.URL+"/chat/completions", "application/json", strings.NewReader(req1))
	if err != nil {
		t.Fatalf("step 1 POST: %v", err)
	}
	defer resp1.Body.Close()

	body1, _ := io.ReadAll(resp1.Body)
	if !strings.Contains(string(body1), "read_file") {
		t.Fatalf("expected tool call to read_file in step 1, got %s", string(body1))
	}

	// Step 2: assistant returns tool result
	req2 := `{
		"model":"gpt-4.1",
		"stream":true,
		"messages":[
			{"role":"user","content":"read readme"},
			{"role":"assistant","content":""},
			{"role":"tool","tool_call_id":"call_fake_1","content":"file data"}
		]
	}`
	resp2, err := http.Post(s.URL+"/chat/completions", "application/json", strings.NewReader(req2))
	if err != nil {
		t.Fatalf("step 2 POST: %v", err)
	}
	defer resp2.Body.Close()

	scanner2 := bufio.NewScanner(resp2.Body)
	var textBuilder2 strings.Builder
	for scanner2.Scan() {
		line := scanner2.Text()
		if strings.HasPrefix(line, "data: ") && line != "data: [DONE]" {
			data := strings.TrimPrefix(line, "data: ")
			var chunk struct {
				Choices []struct {
					Delta struct {
						Content string `json:"content"`
					} `json:"delta"`
				} `json:"choices"`
			}
			if err := json.Unmarshal([]byte(data), &chunk); err == nil && len(chunk.Choices) > 0 {
				textBuilder2.WriteString(chunk.Choices[0].Delta.Content)
			}
		}
	}
	if err := scanner2.Err(); err != nil {
		t.Fatalf("scanner2 error: %v", err)
	}
	if textBuilder2.String() != "The readme content is here." {
		t.Fatalf("expected final text in step 2, got %q", textBuilder2.String())
	}
}

func TestFakeProvider_FailureInjections(t *testing.T) {
	s := fakeprovider.New()
	defer s.Close()

	s.OnPrompt(fakeprovider.Contains("trigger 429")).Error(http.StatusTooManyRequests, `{"error":{"type":"rate_limit_error"}}`)
	s.OnPrompt(fakeprovider.Contains("trigger overflow")).OverContextWindow()

	// 429 rate limit
	resp429, err := http.Post(s.URL+"/v1/chat/completions", "application/json", strings.NewReader(`{"messages":[{"role":"user","content":"trigger 429"}]}`))
	if err != nil {
		t.Fatalf("POST 429: %v", err)
	}
	defer resp429.Body.Close()
	if resp429.StatusCode != http.StatusTooManyRequests {
		t.Errorf("expected 429, got %d", resp429.StatusCode)
	}

	// Context overflow
	respOverflow, err := http.Post(s.URL+"/v1/chat/completions", "application/json", strings.NewReader(`{"messages":[{"role":"user","content":"trigger overflow"}]}`))
	if err != nil {
		t.Fatalf("POST overflow: %v", err)
	}
	defer respOverflow.Body.Close()
	if respOverflow.StatusCode != http.StatusBadRequest {
		t.Errorf("expected 400 for overflow, got %d", respOverflow.StatusCode)
	}
	b, _ := io.ReadAll(respOverflow.Body)
	if !bytes.Contains(b, []byte("context_length_exceeded")) {
		t.Errorf("expected context_length_exceeded, got %s", string(b))
	}
}
