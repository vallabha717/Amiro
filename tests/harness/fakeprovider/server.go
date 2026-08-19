package fakeprovider

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Server is an HTTP server that speaks OpenAI and Anthropic API protocols.
type Server struct {
	server       *httptest.Server
	URL          string
	mu           sync.RWMutex
	rules        []*Rule
	callCount    int64
	lastMessages []Message
	lastPrompt   string
	exchanges    []Exchange
}

// Exchange records one HTTP interaction handled by fakeprovider.
type Exchange struct {
	Method string
	Path   string
	Body   string
}

// New creates and starts a new fakeprovider HTTP server.
func New() *Server {
	s := &Server{
		rules: make([]*Rule, 0),
	}
	s.server = httptest.NewServer(http.HandlerFunc(s.handleHTTP))
	s.URL = s.server.URL
	return s
}

// Close shuts down the server.
func (s *Server) Close() {
	if s.server != nil {
		s.server.Close()
	}
}

// Reset clears all registered rules and request history.
func (s *Server) Reset() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.rules = nil
	s.exchanges = nil
	s.lastMessages = nil
	s.lastPrompt = ""
	atomic.StoreInt64(&s.callCount, 0)
}

// OnPrompt registers a rule matching on prompt content.
func (s *Server) OnPrompt(matcher Matcher) *Rule {
	s.mu.Lock()
	defer s.mu.Unlock()
	r := &Rule{
		Matcher:   matcher,
		ChunkSize: 10,
	}
	s.rules = append(s.rules, r)
	return r
}

// OnAny registers a rule that matches any prompt.
func (s *Server) OnAny() *Rule {
	return s.OnPrompt(Any())
}

// CallCount returns the total number of requests served.
func (s *Server) CallCount() int {
	return int(atomic.LoadInt64(&s.callCount))
}

// LastPrompt returns the latest extracted user prompt.
func (s *Server) LastPrompt() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.lastPrompt
}

// LastMessages returns the parsed messages from the latest request.
func (s *Server) LastMessages() []Message {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.lastMessages
}

// ServeHTTP implements http.Handler.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.handleHTTP(w, r)
}

func (s *Server) handleHTTP(w http.ResponseWriter, r *http.Request) {
	atomic.AddInt64(&s.callCount, 1)

	bodyBytes, _ := io.ReadAll(r.Body)
	bodyStr := string(bodyBytes)

	s.mu.Lock()
	s.exchanges = append(s.exchanges, Exchange{
		Method: r.Method,
		Path:   r.URL.Path,
		Body:   bodyStr,
	})
	s.mu.Unlock()

	// Handle models listing
	if r.Method == http.MethodGet && (strings.HasSuffix(r.URL.Path, "/models") || strings.HasSuffix(r.URL.Path, "/v1/models")) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"object": "list",
			"data": []map[string]any{
				{"id": "gpt-4.1", "object": "model", "owned_by": "openai"},
				{"id": "gpt-4.1-mini", "object": "model", "owned_by": "openai"},
				{"id": "claude-sonnet-4-5", "object": "model", "owned_by": "anthropic"},
				{"id": "claude-haiku-4-5", "object": "model", "owned_by": "anthropic"},
			},
		})
		return
	}

	// Handle realtime session creation
	if strings.Contains(r.URL.Path, "realtime/sessions") {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id":     "sess_fake_12345",
			"object": "realtime.session",
			"model":  "gpt-4o-realtime-preview",
			"client_secret": map[string]any{
				"value":      "ek_fake_secret_123",
				"expires_at": time.Now().Add(time.Hour).Unix(),
			},
		})
		return
	}

	isOpenAI := strings.Contains(r.URL.Path, "chat/completions")
	isAnthropic := strings.Contains(r.URL.Path, "messages")
	if !isOpenAI && !isAnthropic {
		// Fallback: detect by body structure
		if strings.Contains(bodyStr, `"messages"`) {
			isOpenAI = true
		}
	}

	messages, prompt, hasToolResult := parseInboundRequest(bodyBytes)

	s.mu.Lock()
	s.lastMessages = messages
	s.lastPrompt = prompt
	s.mu.Unlock()

	rule := s.findMatchingRule(prompt, messages)

	if rule != nil && rule.Handler != nil {
		if rule.Handler(w, r) {
			return
		}
	}

	if rule != nil && rule.StatusCode > 0 {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(rule.StatusCode)
		if rule.ErrorBody != "" {
			_, _ = w.Write([]byte(rule.ErrorBody))
		} else {
			_, _ = w.Write(fmt.Appendf(nil, `{"error":{"message":"HTTP error %d"}}`, rule.StatusCode))
		}
		return
	}

	// Check if this request asks for streaming
	isStream := strings.Contains(bodyStr, `"stream":true`) || strings.Contains(bodyStr, `"stream": true`)

	if isAnthropic {
		s.handleAnthropic(w, rule, prompt, messages, hasToolResult, isStream)
		return
	}

	s.handleOpenAI(w, rule, prompt, messages, hasToolResult, isStream)
}

func (s *Server) findMatchingRule(prompt string, messages []Message) *Rule {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, r := range s.rules {
		if r.Matcher.Match(prompt, messages) {
			return r
		}
	}
	return nil
}

func parseInboundRequest(body []byte) (messages []Message, prompt string, hasToolResult bool) {
	var generic struct {
		Messages []struct {
			Role       string          `json:"role"`
			Content    json.RawMessage `json:"content"`
			ToolCallID string          `json:"tool_call_id"`
			Type       string          `json:"type"`
		} `json:"messages"`
		Prompt string `json:"prompt"`
	}
	_ = json.Unmarshal(body, &generic)

	for _, m := range generic.Messages {
		var contentStr string
		if len(m.Content) > 0 {
			if err := json.Unmarshal(m.Content, &contentStr); err != nil {
				// Might be array of content blocks (Anthropic or multimodal)
				var blocks []struct {
					Type    string          `json:"type"`
					Text    string          `json:"text"`
					Content json.RawMessage `json:"content"`
				}
				if json.Unmarshal(m.Content, &blocks) == nil {
					for _, b := range blocks {
						if b.Type == "tool_result" {
							hasToolResult = true
						}
						if b.Text != "" {
							contentStr += b.Text + " "
						}
					}
				} else {
					contentStr = string(m.Content)
				}
			}
		}
		msg := Message{
			Role:       m.Role,
			Content:    strings.TrimSpace(contentStr),
			ToolCallID: m.ToolCallID,
		}
		if m.Role == "user" {
			prompt = msg.Content
			hasToolResult = false
		} else if m.Role == "tool" || m.ToolCallID != "" {
			hasToolResult = true
		}
		messages = append(messages, msg)

	}

	if prompt == "" && generic.Prompt != "" {
		prompt = generic.Prompt
	}
	return
}

func (s *Server) handleOpenAI(w http.ResponseWriter, rule *Rule, prompt string, _ []Message, hasToolResult, isStream bool) {
	flusher, _ := w.(http.Flusher)

	// Determine what text/tool call to emit
	text := "Fake response for: " + prompt
	if prompt == "say hello" {
		text = "Hello!"
	}

	var toolCalls []ToolCallSpec
	if rule != nil {
		if hasToolResult && rule.ThenText != "" {
			text = rule.ThenText
		} else if len(rule.ToolCalls) > 0 && !hasToolResult {
			toolCalls = rule.ToolCalls
		} else if rule.Text != "" {
			text = rule.Text
		}

		if rule.MalformedArgsTool != "" && !hasToolResult {
			toolCalls = []ToolCallSpec{{
				ID:        "call_malformed_1",
				Name:      rule.MalformedArgsTool,
				Arguments: rule.MalformedArgsBody,
			}}
		}
	}

	if isStream {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		w.WriteHeader(http.StatusOK)

		if rule != nil && rule.MalformedSSEPayload != "" {
			_, _ = w.Write([]byte(rule.MalformedSSEPayload))
			if flusher != nil {
				flusher.Flush()
			}
			return
		}

		chunkIdx := 0
		maxChunks := 1000
		if rule != nil && rule.TruncateAfterChunks > 0 {
			maxChunks = rule.TruncateAfterChunks
		}

		if len(toolCalls) > 0 {
			for i, tc := range toolCalls {
				if chunkIdx >= maxChunks {
					return
				}
				chunkIdx++
				payload := map[string]any{
					"id":      "chatcmpl-fake-tool",
					"object":  "chat.completion.chunk",
					"created": 1700000000,
					"model":   "gpt-4.1",
					"choices": []map[string]any{
						{
							"index": 0,
							"delta": map[string]any{
								"role": "assistant",
								"tool_calls": []map[string]any{
									{
										"index": i,
										"id":    tc.ID,
										"type":  "function",
										"function": map[string]any{
											"name":      tc.Name,
											"arguments": tc.Arguments,
										},
									},
								},
							},
							"finish_reason": "tool_calls",
						},
					},
				}
				b, _ := json.Marshal(payload)
				_, _ = fmt.Fprintf(w, "data: %s\n\n", b)
				if flusher != nil {
					flusher.Flush()
				}
			}
			_, _ = fmt.Fprintf(w, "data: [DONE]\n\n")
			if flusher != nil {
				flusher.Flush()
			}
			return
		}

		chunkSize := 10
		if rule != nil && rule.ChunkSize > 0 {
			chunkSize = rule.ChunkSize
		}

		runes := []rune(text)
		for i := 0; i < len(runes); i += chunkSize {
			if chunkIdx >= maxChunks {
				return // Abruptly terminate
			}
			chunkIdx++
			end := i + chunkSize
			if end > len(runes) {
				end = len(runes)
			}
			delta := string(runes[i:end])

			payload := map[string]any{
				"id":      "chatcmpl-fake-stream",
				"object":  "chat.completion.chunk",
				"created": 1700000000,
				"model":   "gpt-4.1",
				"choices": []map[string]any{
					{
						"index": 0,
						"delta": map[string]any{
							"content": delta,
						},
					},
				},
			}
			b, _ := json.Marshal(payload)
			_, _ = fmt.Fprintf(w, "data: %s\n\n", b)
			if flusher != nil {
				flusher.Flush()
			}
		}

		if chunkIdx < maxChunks {
			finalPayload := map[string]any{
				"id":      "chatcmpl-fake-stream",
				"object":  "chat.completion.chunk",
				"created": 1700000000,
				"model":   "gpt-4.1",
				"choices": []map[string]any{
					{
						"index":         0,
						"delta":         map[string]any{},
						"finish_reason": "stop",
					},
				},
			}
			fb, _ := json.Marshal(finalPayload)
			_, _ = fmt.Fprintf(w, "data: %s\n\n", fb)
			_, _ = fmt.Fprintf(w, "data: [DONE]\n\n")
			if flusher != nil {
				flusher.Flush()
			}
		}
		return
	}

	// Non-streaming response
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)

	if len(toolCalls) > 0 {
		tcs := make([]map[string]any, len(toolCalls))
		for i, tc := range toolCalls {
			tcs[i] = map[string]any{
				"id":   tc.ID,
				"type": "function",
				"function": map[string]any{
					"name":      tc.Name,
					"arguments": tc.Arguments,
				},
			}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id":      "chatcmpl-fake-obj",
			"object":  "chat.completion",
			"created": 1700000000,
			"model":   "gpt-4.1",
			"choices": []map[string]any{
				{
					"index": 0,
					"message": map[string]any{
						"role":       "assistant",
						"tool_calls": tcs,
					},
					"finish_reason": "tool_calls",
				},
			},
			"usage": map[string]any{
				"prompt_tokens":     15,
				"completion_tokens": 10,
				"total_tokens":      25,
			},
		})
		return
	}

	_ = json.NewEncoder(w).Encode(map[string]any{
		"id":      "chatcmpl-fake-obj",
		"object":  "chat.completion",
		"created": 1700000000,
		"model":   "gpt-4.1",
		"choices": []map[string]any{
			{
				"index": 0,
				"message": map[string]any{
					"role":    "assistant",
					"content": text,
				},
				"finish_reason": "stop",
			},
		},
		"usage": map[string]any{
			"prompt_tokens":     15,
			"completion_tokens": 10,
			"total_tokens":      25,
		},
	})
}

func (s *Server) handleAnthropic(w http.ResponseWriter, rule *Rule, prompt string, _ []Message, hasToolResult, isStream bool) {
	flusher, _ := w.(http.Flusher)

	text := "Fake response for: " + prompt
	if prompt == "say hello" {
		text = "Hello!"
	}

	var toolCalls []ToolCallSpec
	if rule != nil {
		if hasToolResult && rule.ThenText != "" {
			text = rule.ThenText
		} else if len(rule.ToolCalls) > 0 && !hasToolResult {
			toolCalls = rule.ToolCalls
		} else if rule.Text != "" {
			text = rule.Text
		}
	}

	if isStream {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		w.WriteHeader(http.StatusOK)

		_, _ = fmt.Fprintf(w, "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_fake_stream\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"claude-sonnet-4-5\",\"content\":[],\"usage\":{\"input_tokens\":15,\"output_tokens\":1}}}\n\n")
		if flusher != nil {
			flusher.Flush()
		}

		if len(toolCalls) > 0 {
			for i, tc := range toolCalls {
				_, _ = fmt.Fprintf(w, "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":%d,\"content_block\":{\"type\":\"tool_use\",\"id\":%q,\"name\":%q,\"input\":{}}}\n\n", i, tc.ID, tc.Name)
				bArgs, _ := json.Marshal(tc.Arguments)
				_, _ = fmt.Fprintf(w, "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":%d,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":%s}}\n\n", i, bArgs)
				_, _ = fmt.Fprintf(w, "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":%d}\n\n", i)
			}
			_, _ = fmt.Fprintf(w, "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"},\"usage\":{\"output_tokens\":15}}\n\n")
			_, _ = fmt.Fprintf(w, "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n")
			if flusher != nil {
				flusher.Flush()
			}
			return
		}

		chunkSize := 10
		if rule != nil && rule.ChunkSize > 0 {
			chunkSize = rule.ChunkSize
		}

		runes := []rune(text)
		for i := 0; i < len(runes); i += chunkSize {
			end := i + chunkSize
			if end > len(runes) {
				end = len(runes)
			}
			delta := string(runes[i:end])
			bDelta, _ := json.Marshal(delta)
			_, _ = fmt.Fprintf(w, "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":%s}}\n\n", bDelta)
			if flusher != nil {
				flusher.Flush()
			}
		}

		_, _ = fmt.Fprintf(w, "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n")
		_, _ = fmt.Fprintf(w, "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":20}}\n\n")
		_, _ = fmt.Fprintf(w, "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n")
		if flusher != nil {
			flusher.Flush()
		}
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)

	content := []map[string]any{
		{"type": "text", "text": text},
	}
	_ = json.NewEncoder(w).Encode(map[string]any{
		"id":      "msg_fake_obj",
		"type":    "message",
		"role":    "assistant",
		"model":   "claude-sonnet-4-5",
		"content": content,
		"usage": map[string]any{
			"input_tokens":  15,
			"output_tokens": 20,
		},
	})
}
